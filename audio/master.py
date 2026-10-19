"""Mastering + measurement: ITU-R BS.1770-4 loudness (K-weighting, gating),
4x-oversampled true peak, look-ahead true-peak limiter, 24-bit WAV writer, QA plots."""
import os
import struct

import numpy as np
from scipy import signal, ndimage

from dsp import SR

# K-weighting at 48 kHz (BS.1770-4, table 1/2)
_K1 = (np.array([1.53512485958697, -2.69169618940638, 1.19839281085285]),
       np.array([1.0, -1.69065929318241, 0.73248077421585]))
_K2 = (np.array([1.0, -2.0, 1.0]), np.array([1.0, -1.99004745483398, 0.99007225036621]))


def k_weight(x):
    y = signal.lfilter(_K1[0], _K1[1], x, axis=-1)
    return signal.lfilter(_K2[0], _K2[1], y, axis=-1)


def block_power(x, win=0.4, hop=0.1):
    """mean-square per block (summed over channels, G=1 for L/R)."""
    y = k_weight(x)
    p = (y * y).sum(axis=0)
    cs = np.concatenate([[0.0], np.cumsum(p)])
    w, h = int(win * SR), int(hop * SR)
    starts = np.arange(0, len(p) - w + 1, h)
    return (cs[starts + w] - cs[starts]) / w, starts


def integrated_lufs(x):
    z, _ = block_power(x)
    l = -0.691 + 10 * np.log10(z + 1e-20)
    g = z[l > -70.0]
    if g.size == 0:
        return -np.inf
    rel = -0.691 + 10 * np.log10(g.mean()) - 10.0
    g2 = z[(l > -70.0) & (l > rel)]
    return -0.691 + 10 * np.log10(g2.mean())


def loudness_curve(x, win):
    z, starts = block_power(x, win, 0.1)
    return (starts + int(win * SR) / 2) / SR, -0.691 + 10 * np.log10(z + 1e-20)


def oversample(x, f=4):
    return signal.resample_poly(x, f, 1, axis=-1)


def true_peak_dbtp(x):
    pk = 0.0
    for ch in range(x.shape[0]):
        pk = max(pk, np.max(np.abs(oversample(x[ch]))))
    return 20 * np.log10(pk + 1e-20)


def tp_envelope(x):
    """per-sample peak magnitude of the 4x-oversampled signal (max over channels)."""
    n = x.shape[1]
    pk = np.zeros(n)
    for ch in range(x.shape[0]):
        o = np.abs(oversample(x[ch]))[: 4 * n].reshape(n, 4).max(axis=1)
        pk = np.maximum(pk, o)
    pk = np.maximum(pk, np.abs(x).max(axis=0))
    return ndimage.maximum_filter1d(pk, 3)


def limiter_gain(x, ceiling_db=-1.3, look=0.003, release=0.15, block=16):
    """look-ahead gain curve guaranteeing |x*g| <= ceiling at (oversampled) peaks."""
    n = x.shape[1]
    c = 10 ** (ceiling_db / 20)
    pk = tp_envelope(x)
    g = np.minimum(1.0, c / np.maximum(pk, 1e-12))
    L = int(look * SR) | 1
    cen = ndimage.minimum_filter1d(g, L, mode='nearest')
    fwd = np.concatenate([cen[L // 2:], np.ones(L // 2)])  # min over [n, n+L-1]
    nb = int(np.ceil(n / block))
    pad = np.concatenate([fwd, np.ones(nb * block - n)])
    b = pad.reshape(nb, block).min(axis=1)
    a = float(np.exp(-block / (release * SR)))
    r = np.empty(nb)
    prev = 1.0
    bl = b.tolist()
    for i in range(nb):
        v = 1.0 - (1.0 - prev) * a
        bi = bl[i]
        prev = bi if bi < v else v
        r[i] = prev
    rr = np.repeat(r, block)[:n]
    cs = np.concatenate([[0.0], np.cumsum(rr)])
    idx = np.arange(n)
    lo = np.maximum(0, idx - L + 1)
    G = (cs[idx + 1] - cs[lo]) / (idx + 1 - lo)
    return np.minimum(G, fwd)


def write_wav24(path, x):
    """x: (2, n) float in [-1, 1] -> 24-bit PCM WAV."""
    x = np.clip(x, -1.0, 1.0 - 2 ** -23)
    q = np.round(x.T * (2 ** 23)).astype(np.int32)  # interleaved (n, 2)
    b = q.astype('<i4').tobytes()
    a = np.frombuffer(b, dtype=np.uint8).reshape(-1, 4)[:, :3].tobytes()
    nch = x.shape[0]
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(a)) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 1, nch, SR, SR * nch * 3, nch * 3, 24))
        f.write(b'data' + struct.pack('<I', len(a)) + a)


def write_wav_f32(path, x):
    x = x.astype('<f4')
    a = x.T.tobytes()
    nch = x.shape[0]
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 36 + len(a)) + b'WAVE')
        f.write(b'fmt ' + struct.pack('<IHHIIHH', 16, 3, nch, SR, SR * nch * 4, nch * 4, 32))
        f.write(b'data' + struct.pack('<I', len(a)) + a)


def read_wav24(path):
    with open(path, 'rb') as f:
        d = f.read()
    i = d.find(b'data')
    nbytes = struct.unpack('<I', d[i + 4:i + 8])[0]
    raw = np.frombuffer(d[i + 8:i + 8 + nbytes], dtype=np.uint8).reshape(-1, 3)
    v = (raw[:, 0].astype(np.int32) | (raw[:, 1].astype(np.int32) << 8) | (raw[:, 2].astype(np.int32) << 16))
    v = np.where(v >= 2 ** 23, v - 2 ** 24, v)
    return v.reshape(-1, 2).T, v


def qa_plots(x, cues, windows, qa_dir, stems=None):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    os.makedirs(qa_dir, exist_ok=True)
    dur = x.shape[1] / SR
    mono = x.mean(axis=0)
    # --- spectrogram
    f, t, S = signal.spectrogram(mono, fs=SR, nperseg=4096, noverlap=2048, window='hann', mode='magnitude')
    Sdb = 20 * np.log10(S + 1e-9)
    fig, ax = plt.subplots(figsize=(26, 8), dpi=80)
    ax.pcolormesh(t, f, Sdb, shading='auto', cmap='magma', vmin=-130, vmax=-30)
    ax.set_yscale('symlog', linthresh=200)
    ax.set_ylim(20, 24000)
    for k, v in cues.items():
        ax.axvline(v, color='cyan', lw=0.4, alpha=0.5)
    for a, b in windows:
        ax.axvspan(a, b, color='white', alpha=0.12)
    ax.set_xlim(0, dur)
    ax.set_xticks(np.arange(0, dur + 1, 5))
    ax.set_title('XIN score - spectrogram (mono sum); shaded = required digital silence')
    ax.set_xlabel('s')
    fig.tight_layout()
    fig.savefig(os.path.join(qa_dir, 'spectrogram.png'))
    plt.close(fig)
    # --- loudness
    tm, lm = loudness_curve(x, 0.4)
    ts, lsh = loudness_curve(x, 3.0)
    fig, ax = plt.subplots(figsize=(26, 7), dpi=80)
    ax.plot(tm, lm, lw=0.6, color='#888', label='momentary (400 ms)')
    ax.plot(ts, lsh, lw=1.4, color='#d62', label='short-term (3 s)')
    # peak per 50 ms
    h = int(0.05 * SR)
    nb = x.shape[1] // h
    pk = np.abs(x[:, :nb * h]).max(axis=0).reshape(nb, h).max(axis=1)
    ax.plot((np.arange(nb) + 0.5) * h / SR, 20 * np.log10(pk + 1e-9), lw=0.5, color='#27c', label='sample peak dBFS')
    if stems:
        cols = {'music': '#2a2', 'sfx': '#a2a', 'ambience': '#aa2'}
        for k, s in stems.items():
            tt, ll = loudness_curve(s, 3.0)
            ax.plot(tt, ll, lw=0.8, color=cols.get(k, 'k'), alpha=0.7, label=f'{k} short-term')
    ax.axhline(-16, color='k', lw=0.5, ls='--')
    for k, v in cues.items():
        ax.axvline(v, color='c', lw=0.3, alpha=0.6)
        ax.text(v, -2, k, rotation=90, fontsize=5, va='top')
    for a, b in windows:
        ax.axvspan(a, b, color='k', alpha=0.08)
    ax.set_ylim(-70, 0)
    ax.set_xlim(0, dur)
    ax.set_xticks(np.arange(0, dur + 1, 5))
    ax.grid(alpha=0.3)
    ax.legend(loc='lower right', fontsize=8)
    ax.set_title('Loudness over time (LUFS) / peaks (dBFS)')
    fig.tight_layout()
    fig.savefig(os.path.join(qa_dir, 'loudness.png'))
    plt.close(fig)
