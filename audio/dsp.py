"""Core DSP helpers for the XIN score: oscillators, filters, envelopes, noise,
panning, decorrelation, STFT shaping and synthetic reverb impulse responses.

Everything is deterministic: random generators are derived from a global seed
plus a stable text label (crc32), never from Python's randomized hash().
"""
import zlib
from functools import lru_cache

import numpy as np
from scipy import signal

SR = 48000
NYQ = SR / 2.0
SEED = 20260412
TAU = 2.0 * np.pi


# ----------------------------------------------------------------------------
# basics
# ----------------------------------------------------------------------------
def rng_for(label):
    return np.random.default_rng([SEED, zlib.crc32(str(label).encode())])


def ns(t):
    return int(round(float(t) * SR))


def tvec(n):
    return np.arange(n) / SR


_OFFS = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def midi(name):
    if not isinstance(name, str):
        return float(name)
    letter = name[0].upper()
    i, acc = 1, 0
    while i < len(name) and name[i] in '#b':
        acc += 1 if name[i] == '#' else -1
        i += 1
    return 12 * (int(name[i:]) + 1) + _OFFS[letter] + acc


def hz(x):
    return 440.0 * 2.0 ** ((midi(x) - 69) / 12.0)


def db(x):
    return 10.0 ** (np.asarray(x, dtype=float) / 20.0)


# ----------------------------------------------------------------------------
# envelopes
# ----------------------------------------------------------------------------
def env_pts(n, pts, in_db=False):
    """Piecewise-linear envelope over n samples; pts = [(t_sec, value), ...].
    With in_db the values are interpolated in dB (use -120 for silence)."""
    t = np.arange(n) / SR
    tp = np.array([p[0] for p in pts], dtype=float)
    vp = np.array([p[1] for p in pts], dtype=float)
    e = np.interp(t, tp, vp)
    if in_db:
        e = 10.0 ** (e / 20.0)
        e[e < 1.01e-6] = 0.0
    return e


def ease(x):
    """smoothstep 0..1"""
    x = np.clip(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


def ar_env(n, attack, release, hold=None, curve=1.0):
    """Attack (raised cosine) / sustain / release (raised cosine) envelope."""
    t = np.arange(n) / SR
    total = n / SR
    if hold is None:
        hold = total - attack - release
    e = np.ones(n)
    if attack > 0:
        a = t < attack
        e[a] = 0.5 - 0.5 * np.cos(np.pi * t[a] / attack)
    r0 = attack + hold
    if release > 0:
        r = t >= r0
        e[r] = 0.5 + 0.5 * np.cos(np.pi * np.clip((t[r] - r0) / release, 0, 1))
    return e ** curve


def fade_edges(x, fin=0.002, fout=0.002):
    x = np.array(x, dtype=float, copy=True)
    n = x.shape[-1]
    a, b = min(ns(fin), n // 2), min(ns(fout), n // 2)
    if a > 0:
        x[..., :a] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    if b > 0:
        x[..., n - b:] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(b) + 1) / b)
    return x


# ----------------------------------------------------------------------------
# noise
# ----------------------------------------------------------------------------
def white(n, rng):
    return rng.standard_normal(n)


def colored(n, rng, slope_db_oct=-3.0, fmin=8.0):
    """Noise with a spectral slope (dB/octave), unit RMS."""
    x = rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f[0] = fmin
    X *= (np.maximum(f, fmin) / 1000.0) ** (slope_db_oct / 6.0206)
    y = np.fft.irfft(X, n)
    return y / (np.std(y) + 1e-12)


def smooth_noise(n, fc, rng, order=2):
    """Slow random control signal (unit std), band-limited to fc Hz.
    Computed at a low control rate and interpolated."""
    dec = max(1, int(SR / max(fc * 40.0, 50.0)))
    m = n // dec + 8
    crate = SR / dec
    w = rng.standard_normal(m + 200)
    sos = signal.butter(order, min(fc / (crate / 2), 0.95), output='sos')
    y = signal.sosfilt(sos, w)[200:]
    y = (y - y.mean()) / (y.std() + 1e-12)
    xp = np.arange(m) * dec
    return np.interp(np.arange(n), xp, y)


# ----------------------------------------------------------------------------
# filters
# ----------------------------------------------------------------------------
@lru_cache(maxsize=512)
def _butter(kind, f, order):
    f = np.array(f, dtype=float) / NYQ
    f = np.clip(f, 1e-5, 0.999)
    return signal.butter(order, f if f.size > 1 else float(f), btype=kind, output='sos')


def lp(x, f, order=2):
    return signal.sosfilt(_butter('lowpass', float(f), order), x, axis=-1)


def hp(x, f, order=2):
    return signal.sosfilt(_butter('highpass', float(f), order), x, axis=-1)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(_butter('bandpass', (float(lo), float(hi)), order), x, axis=-1)


def lp0(x, f, order=2):
    """zero-phase lowpass"""
    return signal.sosfiltfilt(_butter('lowpass', float(f), order), x, axis=-1)


def _rbj(kind, f0, q, gain_db):
    A = 10 ** (gain_db / 40.0)
    w = TAU * f0 / SR
    cw, sw = np.cos(w), np.sin(w)
    al = sw / (2 * q)
    if kind == 'peak':
        b = [1 + al * A, -2 * cw, 1 - al * A]
        a = [1 + al / A, -2 * cw, 1 - al / A]
    elif kind == 'lowshelf':
        sA = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) - (A - 1) * cw + sA), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sA)]
        a = [(A + 1) + (A - 1) * cw + sA, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sA]
    elif kind == 'highshelf':
        sA = 2 * np.sqrt(A) * al
        b = [A * ((A + 1) + (A - 1) * cw + sA), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sA)]
        a = [(A + 1) - (A - 1) * cw + sA, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sA]
    else:
        raise ValueError(kind)
    b = np.array(b) / a[0]
    a = np.array(a) / a[0]
    return np.concatenate([b, a])


def eq(x, bands):
    """bands: list of (kind, f0, q, gain_db); kind in peak/lowshelf/highshelf"""
    if not bands:
        return x
    sos = np.array([_rbj(k, f, q, g) for (k, f, q, g) in bands])
    return signal.sosfilt(sos, x, axis=-1)


@lru_cache(maxsize=256)
def _reson(f0, q):
    b, a = signal.iirpeak(min(f0, NYQ * 0.95), q, fs=SR)
    return signal.tf2sos(b, a)


def resonator(x, f0, q):
    return signal.sosfilt(_reson(float(f0), float(q)), x, axis=-1)


def formant_bank(x, formants):
    """formants: list of (freq, bandwidth, gain_db); parallel resonators."""
    y = np.zeros_like(x)
    for f, bw, g in formants:
        y += db(g) * resonator(x, f, f / bw)
    return y


# ----------------------------------------------------------------------------
# oscillators
# ----------------------------------------------------------------------------
def phase_of(f, n=None, phi0=0.0):
    if np.isscalar(f):
        return phi0 + TAU * f * np.arange(n) / SR
    return phi0 + TAU * np.cumsum(f) / SR


def additive(ph, fmax, amps, cutoff=16000.0):
    """sum_k amps[k-1]*sin(k*ph), dropping partials above cutoff (band-limited)."""
    out = np.zeros_like(ph)
    for k, a in enumerate(amps, 1):
        fk = k * fmax
        if fk >= cutoff:
            break
        if a == 0:
            continue
        taper = 1.0 if fk < 0.8 * cutoff else 0.5 + 0.5 * np.cos(np.pi * (fk - 0.8 * cutoff) / (0.2 * cutoff))
        out += (a * taper) * np.sin(k * ph)
    return out


def blep_saw(f, n=None, phase0=0.0):
    """PolyBLEP band-limited sawtooth, f scalar or per-sample array."""
    if np.isscalar(f):
        f = np.full(n, float(f))
    dt = f / SR
    p = np.mod(phase0 + np.cumsum(dt), 1.0)
    y = 2.0 * p - 1.0
    m = p < dt
    t = p[m] / dt[m]
    y[m] -= t + t - t * t - 1.0
    m = p > 1.0 - dt
    t = (p[m] - 1.0) / dt[m]
    y[m] -= t * t + t + t + 1.0
    return y


# ----------------------------------------------------------------------------
# space: pan, width, decorrelation
# ----------------------------------------------------------------------------
def pan(x, p=0.0):
    """constant-power pan of a mono signal; p in [-1, 1] (scalar or array)."""
    th = (np.clip(np.asarray(p, dtype=float), -1, 1) + 1.0) * np.pi / 4.0
    return np.stack([x * np.cos(th), x * np.sin(th)])


@lru_cache(maxsize=64)
def _allpass_chain(label, nsec=6):
    r = rng_for('ap' + label)
    rows = []
    for _ in range(nsec):
        f = np.exp(r.uniform(np.log(250), np.log(9000)))
        rad = r.uniform(0.55, 0.82)
        a1 = -2 * rad * np.cos(TAU * f / SR)
        a2 = rad * rad
        rows.append([a2, a1, 1.0, 1.0, a1, a2])
    return np.array(rows)


def decorrelate(x, label):
    """Flat-magnitude allpass decorrelator (only above ~180 Hz so lows stay mono)."""
    lo = lp(x, 180.0, 2)
    hi = x - lo
    return lo + signal.sosfilt(_allpass_chain(label), hi)


def widen(x, label, amount=1.0):
    """mono -> stereo with decorrelated L/R (mono-compatible lows)."""
    L = decorrelate(x, label + 'L')
    R = decorrelate(x, label + 'R')
    m = x * (1 - amount)
    return np.stack([m + amount * L, m + amount * R]) * 0.7071


# ----------------------------------------------------------------------------
# time-varying spectral shaping
# ----------------------------------------------------------------------------
def stft_shape(x, gain_fn, nper=2048):
    """Apply a time/frequency gain G(t, f) to x via STFT. gain_fn(t[1,T], f[F,1])."""
    n = len(x)
    f, t, Z = signal.stft(x, fs=SR, nperseg=nper, noverlap=nper * 3 // 4)
    G = gain_fn(t[None, :], f[:, None])
    _, y = signal.istft(Z * G, fs=SR, nperseg=nper, noverlap=nper * 3 // 4)
    if len(y) < n:
        y = np.pad(y, (0, n - len(y)))
    return y[:n]


def sweep_band(n, rng, fc_curve, q_curve, nper=1024):
    """Noise through a time-varying band (gaussian on log-frequency).
    fc_curve(t) -> centre Hz, q_curve(t) -> width in octaves."""
    x = rng.standard_normal(n)

    def G(t, f):
        fc = fc_curve(t)
        wd = q_curve(t)
        lf = np.log2(np.maximum(f, 10.0))
        return np.exp(-0.5 * ((lf - np.log2(fc)) / wd) ** 2)

    return stft_shape(x, G, nper)


# ----------------------------------------------------------------------------
# reverb
# ----------------------------------------------------------------------------
def make_ir(label, dur, t60_fn, predelay=0.02, buildup=0.015, n_er=14, er_span=0.08, er_gain=0.5):
    """Stereo impulse response: decorrelated noise with frequency-dependent decay
    (t60_fn(f) seconds), diffuse build-up and sparse early reflections.
    Each channel normalised to unit energy."""
    rng = rng_for('ir' + label)
    n = ns(dur)
    pd = ns(predelay)
    out = np.zeros((2, n + pd))
    t = np.arange(n) / SR
    for ch in range(2):
        x = rng.standard_normal(n)
        y = stft_shape(x, lambda tt, ff: np.exp(-6.9078 * tt / t60_fn(np.maximum(ff, 20.0))), 1024)
        y *= 1.0 - np.exp(-t / buildup)
        y /= np.sqrt(np.sum(y * y))
        er = np.zeros(n)
        times = np.sort(rng.uniform(0.003, er_span, n_er))
        for k, tk in enumerate(times):
            i = ns(tk)
            er[i] += rng.choice([-1, 1]) * er_gain * np.exp(-tk / (er_span * 0.7)) * rng.uniform(0.4, 1.0)
        er = lp(er, 7000.0, 1)
        y = y + er * 0.6
        y = hp(y, 25.0, 2)
        y /= np.sqrt(np.sum(y * y))
        out[ch, pd:] = y
    w = np.ones(n + pd)
    k = ns(0.25)
    w[-k:] = 0.5 + 0.5 * np.cos(np.pi * np.arange(k) / k)
    return out * w


def t60_curve(low, mid, high, air):
    """Return f -> T60 interpolated over log-frequency: 100 Hz, 1 kHz, 6 kHz, 16 kHz"""
    fp = np.log2([100.0, 1000.0, 6000.0, 16000.0])
    vp = np.array([low, mid, high, air])

    def fn(f):
        return np.interp(np.log2(f), fp, vp)

    return fn


def convolve_stereo(x, ir, cross=0.25):
    """x: (2, n) stereo; ir: (2, m). Returns (2, n) wet (tail truncated)."""
    n = x.shape[1]
    inL = (1 - cross) * x[0] + cross * x[1]
    inR = (1 - cross) * x[1] + cross * x[0]
    wl = signal.oaconvolve(inL, ir[0])[:n]
    wr = signal.oaconvolve(inR, ir[1])[:n]
    return np.stack([wl, wr])


# ----------------------------------------------------------------------------
# misc processing
# ----------------------------------------------------------------------------
def softclip(x, drive=1.0):
    return np.tanh(drive * x) / np.tanh(drive)


def digitize(x, sr_d, bits, ref=None):
    """Zero-order-hold sample-rate reduction + bit-depth quantisation."""
    n = len(x)
    if ref is None:
        ref = np.max(np.abs(x)) + 1e-12
    step = SR / float(sr_d)
    idx = (np.floor(np.arange(n) / step) * step).astype(np.int64)
    idx = np.minimum(idx, n - 1)
    y = x[idx] / ref
    q = 2.0 ** (bits - 1)
    y = np.round(y * q) / q
    return y * ref


def frac_delay(x, d):
    """Time-varying delay (seconds array or scalar) via linear interpolation."""
    n = len(x)
    pos = np.arange(n) - np.asarray(d) * SR
    return np.interp(pos, np.arange(n), x, left=0.0, right=0.0)
