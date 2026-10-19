"""Synthesised instruments for XIN. All return float64 arrays at 48 kHz
(mono 1-D unless stated). Nothing here uses samples."""
import numpy as np

from dsp import (SR, TAU, ns, tvec, hz, midi, rng_for, additive, blep_saw, lp, hp, bp,
                 eq, formant_bank, smooth_noise, ar_env, colored, phase_of)


# ----------------------------------------------------------------------------
# Piano (the candle's instrument): inharmonic additive strings, two-stage decay,
# hammer-position comb, unison string detune, hammer thump, damper.
# ----------------------------------------------------------------------------
def piano(note, dur, vel=0.6, label='', ring=None, cutoff=13000.0):
    m = midi(note)
    f0 = hz(m)
    rng = rng_for(f'piano|{label}|{m}|{dur}|{vel}')
    B = float(np.clip(3.2e-4 * 2 ** ((m - 60) / 12 * 0.9), 6e-5, 3e-3))
    s = 2 ** (-(m - 60) / 12 * 0.55)
    tau1, tau2 = 0.75 * s, 4.2 * s
    if ring is None:
        ring = dur + 0.45
    n = ns(ring + 0.02)
    t = tvec(n)
    p = 2.2 - 1.2 * vel
    x0 = 1 / 7.7
    if m < 34:
        dets = [0.0, 0.6]
    elif m < 46:
        dets = [-0.35, 0.4]
    else:
        dets = [0.0, 0.42, -0.5]
    damp = np.ones(n)
    kd = ns(dur)
    if kd < n:
        damp[kd:] = np.exp(-(t[kd:] - dur) / (0.09 + 0.12 * s))
    out = np.zeros(n)
    for k in range(1, 49):
        fk = k * f0 * np.sqrt(1 + B * k * k)
        if fk > cutoff:
            break
        a = (1.0 / k ** p) * (abs(np.sin(np.pi * k * x0)) + 0.06)
        if k == 1:
            a *= 0.85
        t1 = tau1 / (1 + (fk / 1800.0) ** 1.1)
        t2 = tau2 / (1 + (fk / 2600.0) ** 1.0)
        # truncate partial where it falls under -100 dB re: its start
        nk = min(n, ns(max(t1, t2) * 11.5) + 1)
        if a < 2e-4:
            continue
        tt = t[:nk]
        e = (0.7 * np.exp(-tt / t1) + 0.3 * np.exp(-tt / t2)) * damp[:nk]
        acc = np.zeros(nk)
        for dc in dets:
            fd = fk * 2 ** (dc / 1200.0)
            acc += np.sin(TAU * fd * tt + rng.uniform(0, TAU))
        out[:nk] += (a / len(dets)) * e * acc
    out *= 1.0 - np.exp(-t / 0.0012)
    # hammer thump / felt noise
    nn = min(n, ns(0.08))
    th = rng.standard_normal(nn) * np.exp(-tvec(nn) / 0.010)
    th = lp(th, 600 + 3500 * vel, 2)
    out[:nn] += 0.05 * vel * th
    out = eq(out, [('peak', 110.0, 1.0, 2.0), ('peak', 650.0, 1.2, -1.5),
                   ('peak', 3200.0, 1.0, 1.5 * vel - 0.5), ('highshelf', 9000.0, 0.7, -4.0)])
    return out * (0.25 + 0.75 * vel ** 1.4) * 0.5


# ----------------------------------------------------------------------------
# Bowed solo string (the warm flame's cello): additive Helmholtz saw with
# time-varying brightness, pitch-synchronous bow noise, body resonances.
# ----------------------------------------------------------------------------
CELLO_BODY = [('peak', 98.0, 3.0, 3.0), ('peak', 196.0, 5.0, 5.0), ('peak', 290.0, 4.0, 2.5),
              ('peak', 410.0, 4.0, 3.5), ('peak', 580.0, 3.0, -3.0), ('peak', 1050.0, 2.0, 2.5),
              ('peak', 2300.0, 1.4, 3.5), ('peak', 4600.0, 0.8, -6.0), ('highshelf', 7500.0, 0.7, -9.0)]


def bowed(f, amp, bright, label, noise=0.025, body=CELLO_BODY, cutoff=11000.0):
    """f, amp, bright: per-sample arrays (Hz, linear, 0..1). Each partial is
    faded out per-sample as k*f(t) approaches the cutoff (strictly band-limited)."""
    rng = rng_for('bow|' + label)
    n = len(f)
    ph = phase_of(f)
    fmin = float(np.min(f))
    kc = 3.0 + 16.0 * np.clip(bright, 0, 1)
    r = np.exp(-1.0 / kc)
    w = np.ones(n)
    out = np.zeros(n)
    for k in range(1, int(cutoff / fmin) + 1):
        tap = np.clip((cutoff - k * f) / (0.2 * cutoff), 0.0, 1.0)
        if not tap.any():
            break
        out += (1.0 / k) * w * tap * np.sin(k * ph)
        w = w * r
        if k > 6 and float(w.max()) < 1e-4:
            break
    nz = bp(rng.standard_normal(n), 1800.0, 6500.0, 2) * (1.0 + 0.7 * np.sin(ph))
    out = out * amp + noise * nz * amp
    return eq(out, body)


def pitch_curve(notes, n, t0=0.0, glide=0.09):
    """notes: [(t_abs, note[, glide_s]), ...] -> per-sample MIDI pitch with
    raised-cosine portamento between notes."""
    t = t0 + tvec(n)
    p = np.full(n, float(midi(notes[0][1])))
    for i in range(1, len(notes)):
        ti = notes[i][0]
        g = notes[i][2] if len(notes[i]) > 2 else glide
        x = np.clip((t - ti) / g, 0, 1)
        x = 0.5 - 0.5 * np.cos(np.pi * x)
        p += (midi(notes[i][1]) - midi(notes[i - 1][1])) * x
    return p


def legato_line(notes, n, t0=0.0, glide=0.09, vib_rate=5.3, vib_cents=16.0, vib_delay=0.35,
                label='line', jitter_cents=2.5):
    """notes: [(t_start_abs, note), ...] in absolute seconds; returns per-sample
    frequency array of length n starting at absolute time t0 (vibrato included)."""
    rng = rng_for('legato|' + label)
    t = t0 + tvec(n)
    times = np.array([a for a, _ in notes])
    pitches = np.array([midi(b) for _, b in notes], dtype=float)
    # piecewise constant pitch with smooth (raised-cosine) glides at each change
    p = np.full(n, pitches[0])
    vib_amt = np.zeros(n)
    for i in range(1, len(notes)):
        ti = times[i]
        x = np.clip((t - ti) / glide, 0, 1)
        x = 0.5 - 0.5 * np.cos(np.pi * x)
        p += (pitches[i] - pitches[i - 1]) * x
    for i in range(len(notes)):
        ti = times[i]
        te = times[i + 1] if i + 1 < len(notes) else t[-1] + 1
        m = (t >= ti) & (t < te)
        vib_amt[m] = np.clip((t[m] - ti - vib_delay) / 0.6, 0, 1)
    vib_amt = np.convolve(vib_amt, np.ones(ns(0.08)) / ns(0.08), 'same')
    rate = vib_rate * (1 + 0.04 * smooth_noise(n, 0.4, rng))
    vph = TAU * np.cumsum(rate) / SR
    cents = vib_cents * vib_amt * np.sin(vph) + jitter_cents * smooth_noise(n, 3.0, rng)
    return 440.0 * 2 ** ((p - 69) / 12.0) * 2 ** (cents / 1200.0)


# ----------------------------------------------------------------------------
# String section voices (raw, unfiltered) -> processed on the strings bus
# ----------------------------------------------------------------------------
def section_note(note, n, label, voices=3, detune=6.0, vib_cents=9.0, spread=0.5, pan0=0.0, fcurve=None):
    """Returns stereo (2, n) raw band-limited saws of an ensemble playing one note."""
    f0 = hz(note) if fcurve is None else fcurve
    rng = rng_for(f'sect|{label}|{note}|{n}')
    out = np.zeros((2, n))
    for v in range(voices):
        dc = detune * (v - (voices - 1) / 2) / max(1, (voices - 1) / 2) + rng.normal(0, 1.5)
        rate = rng.uniform(4.6, 5.9)
        depth = vib_cents * rng.uniform(0.6, 1.2) * (0.6 + 0.4 * (1 + smooth_noise(n, 0.3, rng)) / 2)
        cents = dc + depth * np.sin(TAU * rate * tvec(n) + rng.uniform(0, TAU)) + 3.0 * smooth_noise(n, 0.5, rng)
        f = f0 * 2 ** (cents / 1200.0)
        y = blep_saw(f, phase0=rng.uniform())
        y *= 1 + 0.08 * smooth_noise(n, 2.0, rng)
        pp = np.clip(pan0 + spread * (v - (voices - 1) / 2) / max(1, (voices - 1) / 2), -1, 1)
        th = (pp + 1) * np.pi / 4
        out[0] += y * np.cos(th)
        out[1] += y * np.sin(th)
    return out / np.sqrt(voices)


VIOLIN_BODY = [('peak', 280.0, 2.0, 2.0), ('peak', 450.0, 3.0, 2.5), ('peak', 1100.0, 1.5, -2.0),
               ('peak', 2700.0, 1.2, 3.0), ('peak', 5200.0, 1.0, -3.0)]


def strings_process(raw, bright):
    """raw: (2, n) bus; bright: (n,) 0..1 automation (crossfade dark/bright LP)."""
    dark = lp(raw, 1400.0, 2)
    br = lp(raw, 6500.0, 2)
    b = np.clip(bright, 0, 1)
    y = dark * (1 - b) + br * b
    y = eq(y, [('peak', 200.0, 1.0, 2.0), ('peak', 420.0, 2.0, 1.5), ('peak', 1100.0, 1.4, -1.5),
               ('peak', 2600.0, 1.2, 2.5), ('highshelf', 8000.0, 0.7, -6.0)])
    return hp(y, 45.0, 2)


# ----------------------------------------------------------------------------
# Choir (the copies): perfectly-tuned glottal source + formant bank
# ----------------------------------------------------------------------------
VOWEL_A = [(700, 100, 0), (1150, 110, -5), (2700, 150, -15), (3500, 200, -23), (4500, 250, -33)]
VOWEL_O = [(450, 80, 0), (800, 90, -9), (2800, 130, -21), (3500, 180, -26), (4500, 230, -36)]
VOWEL_U = [(330, 70, 0), (700, 90, -12), (2550, 130, -28), (3500, 180, -36), (4500, 230, -46)]


def choir_source(note, n, phase0=0.0, f=None):
    """glottal-ish source: band-limited saw, -12 dB/oct above ~700 Hz. Exact pitch."""
    if f is None:
        y = blep_saw(float(hz(note)), n=n, phase0=phase0)
    else:
        y = blep_saw(f, phase0=phase0)
    return lp(y, 700.0, 1)


def choir_process(raw, vowel_mix=0.35):
    """raw mono or (2,n). Fixed vowel: 'ah' blended with 'oh'."""
    a = formant_bank(raw, VOWEL_A)
    o = formant_bank(raw, VOWEL_O)
    y = (1 - vowel_mix) * a + vowel_mix * o
    return hp(y, 90.0, 2) * 1.6


# ----------------------------------------------------------------------------
# Glass, bells, chimes, plucks
# ----------------------------------------------------------------------------
def glass(note, n, label, beat=0.22, h2=0.12, h3=0.04, trem=0.06):
    """glass-harmonica tone: two near-unison sines (slow beating) + faint harmonics."""
    f = hz(note)
    rng = rng_for('glass|' + label)
    t = tvec(n)
    p1, p2 = rng.uniform(0, TAU, 2)
    y = np.sin(TAU * f * t + p1) + np.sin(TAU * (f + beat) * t + p2)
    y += h2 * np.sin(TAU * 2 * f * t + p2) + h3 * np.sin(TAU * 3 * f * t + p1)
    y *= 1 + trem * smooth_noise(n, 0.7, rng)
    return y * 0.5


def chime(note, dur, label, bright=0.3, decay=1.2, partials=None):
    """clean digital 'ding' (sine family) - the machine's bell."""
    f = hz(note)
    n = ns(dur)
    t = tvec(n)
    if partials is None:
        partials = [(1.0, 1.0, 1.0), (2.0, 0.25 * bright, 0.5), (3.0, 0.08 * bright, 0.33), (4.0, 0.03 * bright, 0.25)]
    y = np.zeros(n)
    for r, a, dmul in partials:
        if f * r > 18000:
            continue
        y += a * np.sin(TAU * f * r * t) * np.exp(-t / (decay * dmul))
    y *= 1 - np.exp(-t / 0.0008)
    return y


def ting(note, dur, label):
    """the first star: bright glassy bell with inharmonic partials."""
    f = hz(note)
    rng = rng_for('ting|' + label)
    n = ns(dur)
    t = tvec(n)
    parts = [(1.0, 1.0, 2.6), (2.0, 0.18, 1.1), (2.756, 0.35, 1.2), (5.404, 0.12, 0.5), (8.933, 0.05, 0.25)]
    y = np.zeros(n)
    for r, a, d in parts:
        if f * r > 19000:
            continue
        fr = f * r
        y += a * (np.sin(TAU * fr * t + rng.uniform(0, TAU)) + 0.6 * np.sin(TAU * (fr + 0.7) * t)) * np.exp(-t / d)
    y *= 1 - np.exp(-t / 0.0006)
    return y * 0.6


def bell(note, dur, label, strike=1.0):
    """low church-like bell: hum, prime, tierce, quint, nominal..."""
    f = hz(note)
    rng = rng_for('bell|' + label)
    n = ns(dur)
    t = tvec(n)
    parts = [(0.5, 0.9, 14.0), (1.0, 0.8, 8.0), (1.19, 0.5, 6.0), (1.5, 0.3, 5.0), (2.0, 0.6, 4.0),
             (2.51, 0.22, 2.5), (2.66, 0.18, 2.3), (3.01, 0.25, 2.0), (4.16, 0.12, 1.2), (5.43, 0.07, 0.8),
             (6.8, 0.04, 0.5)]
    y = np.zeros(n)
    for r, a, d in parts:
        fr = f * r
        if fr > 16000:
            continue
        for split in (-0.12, 0.12):
            y += 0.5 * a * np.sin(TAU * (fr + split * r) * t + rng.uniform(0, TAU)) * np.exp(-t / d)
    y *= 1 - np.exp(-t / 0.002)
    nn = ns(0.05)
    y[:nn] += 0.15 * strike * lp(rng.standard_normal(nn), 2500, 2) * np.exp(-tvec(nn) / 0.008)
    return y * 0.4


def pluck(note, dur, bright, label, pw_odd=0.55):
    """computation arp voice: band-limited pulse-ish additive pluck with per-harmonic decay."""
    f = hz(note)
    rng = rng_for('pluck|' + label)
    n = ns(dur)
    t = tvec(n)
    y = np.zeros(n)
    base_tau = 0.09 + 0.05 * bright
    for k in range(1, 40):
        fk = k * f
        if fk > 15000:
            break
        a = (1.0 / k) * (1.0 if k % 2 else pw_odd)
        tk = base_tau / (1 + (k - 1) * (0.55 - 0.4 * bright))
        y += a * np.sin(TAU * fk * t) * np.exp(-t / tk)
    y += 0.4 * np.sin(TAU * f * t) * np.exp(-t / (base_tau * 2.2))
    y *= 1 - np.exp(-t / 0.0007)
    return y * 0.5


def mallet(note, dur, label, soft=0.5):
    """delicate glass-mallet pulse (brain): sine + 4th/10th partials."""
    f = hz(note)
    n = ns(dur)
    t = tvec(n)
    y = np.sin(TAU * f * t) * np.exp(-t / 0.9)
    y += 0.25 * (1 - soft) * np.sin(TAU * 3.98 * f * t) * np.exp(-t / 0.18)
    y += 0.08 * (1 - soft) * np.sin(TAU * 9.8 * f * t) * np.exp(-t / 0.05)
    y *= 1 - np.exp(-t / (0.002 + 0.004 * soft))
    return y * 0.5


def sine_pad(note, n, label, trem=0.0, quant=0):
    """cold sine glimmer; optional stepped (quantised) tremolo for the machine."""
    f = hz(note)
    rng = rng_for('sinepad|' + label)
    t = tvec(n)
    y = np.sin(TAU * f * t + rng.uniform(0, TAU))
    if trem > 0:
        lfo = 0.5 + 0.5 * np.sin(TAU * 0.5 * t + rng.uniform(0, TAU))
        if quant:
            lfo = np.round(lfo * quant) / quant
            lfo = np.convolve(lfo, np.ones(96) / 96, 'same')
        y *= 1 - trem * lfo
    return y


def brass_pad(notes, n, label, open_curve):
    """dark low brass/organ-like saw stack for the ignition chord; open_curve 0..1 (filter)."""
    out = np.zeros(n)
    rng = rng_for('brass|' + label)
    for i, nt in enumerate(notes):
        for dc in (-4.0, 4.0):
            f = hz(nt) * 2 ** ((dc + 2.0 * smooth_noise(n, 0.4, rng)) / 1200)
            out += blep_saw(f, phase0=rng.uniform())
    dark = lp(out, 500.0, 2)
    br = lp(out, 2600.0, 2)
    return (dark * (1 - open_curve) + br * open_curve) / np.sqrt(2 * len(notes))


def sub_tone(note, n, label, harm=0.25):
    f = hz(note)
    t = tvec(n)
    rng = rng_for('sub|' + label)
    y = np.sin(TAU * f * t + rng.uniform(0, TAU)) + harm * np.sin(TAU * 2 * f * t)
    return y
