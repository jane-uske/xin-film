"""Sound effects, foley and ambience for XIN (all synthesised)."""
import numpy as np

from dsp import (SR, TAU, ns, tvec, hz, rng_for, lp, hp, bp, eq, resonator, smooth_noise,
                 stft_shape, sweep_band, softclip, phase_of, pan, widen, colored, ar_env,
                 decorrelate, fade_edges)


# ----------------------------------------------------------------------------
# small pitched / transient elements
# ----------------------------------------------------------------------------
def grain(f, dur, shape='hann'):
    n = max(8, ns(dur))
    t = tvec(n)
    w = 0.5 - 0.5 * np.cos(TAU * np.arange(n) / (n - 1)) if shape == 'hann' else np.exp(-t / (dur / 4)) * (1 - np.exp(-t / 0.002))
    return np.sin(TAU * f * t) * w


def star_ping(f, label, dur=1.6):
    """delicate hero-star ping: soft sine + faint inharmonic partial."""
    rng = rng_for('ping|' + label)
    n = ns(dur)
    t = tvec(n)
    y = np.sin(TAU * f * t + rng.uniform(0, TAU)) * np.exp(-t / 0.5)
    y += 0.18 * np.sin(TAU * 2.756 * f * t) * np.exp(-t / 0.12)
    y *= 1 - np.exp(-t / 0.0015)
    return y


def tick(label, f=None, dur=0.06):
    """very light constellation tick: tiny filtered click + faint high pip."""
    rng = rng_for('tick|' + label)
    n = ns(dur)
    t = tvec(n)
    c = rng.standard_normal(n) * np.exp(-t / 0.0007)
    c = bp(c, 2500.0, 9000.0, 2)
    y = c * 0.8
    if f is not None:
        y += 0.22 * np.sin(TAU * f * t) * np.exp(-t / 0.018) * (1 - np.exp(-t / 0.0004))
    return y


def click(label, bright=1.0, dur=0.02):
    rng = rng_for('click|' + label)
    n = ns(dur)
    t = tvec(n)
    x = rng.standard_normal(n) * np.exp(-t / 0.0006)
    return bp(x, 1200.0 + 800 * bright, 11000.0, 2)


# ----------------------------------------------------------------------------
# whooshes, risers, hits
# ----------------------------------------------------------------------------
def whoosh(dur, label, peak=0.5, f_lo=400.0, f_hi=3500.0, width_oct=1.2, pan_from=-0.8, pan_to=0.8,
           attack_pow=2.0, release_pow=1.5):
    """Noise pass-by: band rises toward the peak (approach) then falls (doppler), panned."""
    rng = rng_for('whoosh|' + label)
    n = ns(dur)
    pk = peak * dur

    def fc(t):
        x = np.where(t < pk, (t / pk), 1 - (t - pk) / max(1e-3, dur - pk))
        x = np.clip(x, 0, 1)
        return f_lo * (f_hi / f_lo) ** x

    y = sweep_band(n, rng, fc, lambda t: width_oct + 0 * t)
    t = tvec(n)
    e = np.where(t < pk, (t / pk) ** attack_pow, (1 - (t - pk) / (dur - pk)) ** release_pow)
    e = np.clip(e, 0, 1)
    y = y * e
    y /= np.max(np.abs(y)) + 1e-12
    pp = pan_from + (pan_to - pan_from) * np.clip(t / dur, 0, 1)
    st = pan(y, pp)
    # a little decorrelated air so it feels wide
    air = widen(y, label + 'air', 1.0) * 0.35
    return st + air


def reverse_swell(dur, label, f_start=600.0, f_end=12000.0, end_fade=0.012):
    """reversed-cymbal-like noise crescendo: spectrum opens, cuts at the end."""
    rng = rng_for('rev|' + label)
    n = ns(dur)
    t = tvec(n)

    def G(tt, ff):
        x = np.clip(tt / dur, 0, 1)
        fc = f_start * (f_end / f_start) ** (x ** 1.5)
        return 1.0 / np.sqrt(1 + (ff / fc) ** 4) * np.minimum(1, (ff / 150.0) ** 2)

    out = np.zeros((2, n))
    for ch in range(2):
        y = stft_shape(rng.standard_normal(n), G, 1024)
        out[ch] = y
    e = np.exp((t - dur) / (dur * 0.22))
    out *= e
    k = ns(end_fade)
    out[:, -k:] *= np.linspace(1, 0, k)
    return out / (np.max(np.abs(out)) + 1e-12)


def riser_tone(dur, label, f0, f1, fifth=True):
    rng = rng_for('riser|' + label)
    n = ns(dur)
    t = tvec(n)
    x = t / dur
    f = f0 * (f1 / f0) ** (x ** 1.6)
    y = np.sin(phase_of(f)) + 0.35 * np.sin(phase_of(f * 2.0))
    if fifth:
        y += 0.6 * np.sin(phase_of(f * 1.5))
    trem_rate = 3 + 14 * x ** 2
    y *= 1 - 0.25 * (0.5 + 0.5 * np.sin(np.cumsum(TAU * trem_rate) / SR))
    e = x ** 2.2
    return widen(y * e, label, 0.8)


def suck_out(dur, label):
    """1-second inward implosion: reversed bright noise + rising low tone, width collapsing."""
    rng = rng_for('suck|' + label)
    n = ns(dur)
    t = tvec(n)
    x = t / dur

    def G(tt, ff):
        xx = np.clip(tt / dur, 0, 1)
        fc = 300.0 * (14000.0 / 300.0) ** (xx ** 1.3)
        return 1 / np.sqrt(1 + (ff / fc) ** 4)

    L = stft_shape(rng.standard_normal(n), G, 1024)
    R = stft_shape(rng.standard_normal(n), G, 1024)
    M = 0.5 * (L + R)
    w = (1 - x) ** 1.5  # width collapses to the centre
    st = np.stack([M + w * (L - M), M + w * (R - M)])
    e = np.exp((t - dur) / (dur * 0.25)) * (1 - np.exp(-t / 0.05))
    st *= e
    f = 35.0 * (140.0 / 35.0) ** x
    tone = np.sin(phase_of(f)) * e * 0.6
    st += np.stack([tone, tone])
    k = ns(0.006)
    st[:, -k:] *= np.linspace(1, 0, k)
    return st / (np.max(np.abs(st)) + 1e-12)


def sub_drop(dur, label, f_hi=60.0, f_lo=25.0, tau_f=0.9):
    t = tvec(ns(dur))
    f = f_lo + (f_hi - f_lo) * np.exp(-t / tau_f)
    y = np.sin(phase_of(f))
    e = (1 - np.exp(-t / 0.004)) * (0.6 * np.exp(-t / 1.4) + 0.4 * np.exp(-t / 3.8))
    y = softclip(2.2 * y * e, 1.0)
    y += 0.25 * np.sin(phase_of(2 * f)) * np.exp(-t / 0.5)
    y = lp(y, 220.0, 2)
    y = fade_edges(y, 0.0, 0.3)
    return y


def impact_burst(dur, label):
    """bright noise burst + crunch + transient (stereo, decorrelated)."""
    rng = rng_for('impact|' + label)
    n = ns(dur)
    t = tvec(n)
    out = np.zeros((2, n))
    for ch in range(2):
        w = rng.standard_normal(n)
        bright = hp(w, 1500.0, 2) * (np.exp(-t / 0.13) + 0.18 * np.exp(-t / 1.1))
        crunch = bp(rng.standard_normal(n), 250.0, 3000.0, 2) * np.exp(-t / 0.28)
        out[ch] = 0.8 * bright + 0.6 * crunch
    out *= 1 - np.exp(-t / 0.0008)
    cl = bp(rng.standard_normal(ns(0.01)), 800, 12000, 2) * np.exp(-tvec(ns(0.01)) / 0.0015)
    out[:, :len(cl)] += 2.5 * cl
    out = fade_edges(out, 0.0, 0.5)
    return out / np.max(np.abs(out))


def boom(dur, label, f0=48.0):
    """punchy body of the hit."""
    t = tvec(ns(dur))
    f = f0 * (1 + 1.5 * np.exp(-t / 0.03))
    y = np.sin(phase_of(f)) * np.exp(-t / 0.35) * (1 - np.exp(-t / 0.002))
    return softclip(1.5 * y, 1.0)


# ----------------------------------------------------------------------------
# beds
# ----------------------------------------------------------------------------
def rumble(n, label, cutoff_fn, swirl_rate_fn=None):
    """low rumble whose lowpass cutoff follows cutoff_fn(t); returns stereo,
    optionally swirling around the listener (pan rotating at swirl_rate_fn(t) Hz)."""
    rng = rng_for('rumble|' + label)

    def G(tt, ff):
        fc = cutoff_fn(tt)
        return 1 / np.sqrt(1 + (ff / fc) ** 4) * np.minimum(1.0, (ff / 25.0) ** 2)

    L = stft_shape(colored(n, rng, -3.0), G, 2048)
    R = stft_shape(colored(n, rng, -3.0), G, 2048)
    if swirl_rate_fn is not None:
        t = tvec(n)
        ph = np.cumsum(TAU * swirl_rate_fn(t)) / SR
        a = 0.5 + 0.35 * np.sin(ph)
        L, R = L * (1 - a) * 1.4, R * a * 1.4
    return np.stack([L, R])


def plasma(n, label):
    """boiling stellar roar: low noise with two slowly drifting resonant bands, AM 'granulation'."""
    rng = rng_for('plasma|' + label)
    t = tvec(n)
    c1 = smooth_noise(n, 0.15, rng)
    c2 = smooth_noise(n, 0.11, rng)
    ctl_t = t[::512]

    def G(tt, ff):
        i = np.clip((tt / (512 / SR)).astype(int), 0, len(ctl_t) - 1)
        f1 = 110 * 2 ** (0.8 * c1[::512][i])
        f2 = 420 * 2 ** (0.7 * c2[::512][i])
        base = 1 / (1 + (ff / 160.0) ** 2) * np.minimum(1, (ff / 30) ** 2)
        b1 = 1.2 * np.exp(-0.5 * (np.log2(np.maximum(ff, 10) / f1) / 0.35) ** 2)
        b2 = 0.5 * np.exp(-0.5 * (np.log2(np.maximum(ff, 10) / f2) / 0.45) ** 2)
        return base + b1 + b2

    out = np.zeros((2, n))
    for ch in range(2):
        x = stft_shape(colored(n, rng, -2.0), G, 2048)
        am = np.clip(1 + 0.45 * smooth_noise(n, 6.0, rng) + 0.25 * smooth_noise(n, 0.7, rng), 0.15, None)
        out[ch] = x * am
    return out / (np.max(np.abs(out)) + 1e-12)


def air_bed(n, label, lo=300.0, hi=9000.0):
    rng = rng_for('air|' + label)
    out = np.zeros((2, n))
    for ch in range(2):
        x = bp(colored(n, rng, -4.0), lo, hi, 2)
        out[ch] = x * (1 + 0.3 * smooth_noise(n, 0.2, rng))
    return out / (np.max(np.abs(out)) + 1e-12)


# ----------------------------------------------------------------------------
# brain / machine
# ----------------------------------------------------------------------------
def heartbeat_hit(label, strength=1.0):
    rng = rng_for('hb|' + label)
    n = ns(0.35)
    t = tvec(n)
    f = 40.0 + 28.0 * np.exp(-t / 0.035)
    y = np.sin(phase_of(f)) * np.exp(-t / 0.075) * (1 - np.exp(-t / 0.006))
    y = softclip(1.8 * y, 1.0)
    y += 0.25 * lp(rng.standard_normal(n), 160.0, 2) * np.exp(-t / 0.03)
    return y * strength


def heartbeat(times, label, dub_gap=0.26, dub_gain=0.6):
    """returns list of (time, mono) for lub-dub pairs."""
    ev = []
    for i, tb in enumerate(times):
        ev.append((tb, heartbeat_hit(f'{label}{i}a', 1.0)))
        ev.append((tb + dub_gap, heartbeat_hit(f'{label}{i}b', dub_gain)))
    return ev


def neural_crackle(n, label, rate=18.0, zip_rate=0.6):
    """sparse tiny electrical crackles scattered in stereo, plus action-potential 'zips'."""
    rng = rng_for('neural|' + label)
    out = np.zeros((2, n))
    dur = n / SR
    cn = ns(0.006)
    for _ in range(rng.poisson(rate * dur)):
        i = rng.integers(0, n - cn)
        x = rng.standard_normal(cn) * np.exp(-tvec(cn) / rng.uniform(0.0003, 0.0012))
        x = resonator(x, rng.uniform(1800, 7500), rng.uniform(2, 6))
        a = rng.lognormal(0, 0.6) * 0.5
        out[:, i:i + cn] += pan(x * a, rng.uniform(-0.95, 0.95))
    for _ in range(rng.poisson(zip_rate * dur)):
        i0 = rng.integers(0, n - ns(0.25))
        p0 = rng.uniform(-0.9, 0.9)
        p1 = np.clip(p0 + rng.uniform(-0.8, 0.8), -1, 1)
        k = rng.integers(5, 10)
        f = rng.uniform(2500, 6000)
        for j in range(k):
            x = rng.standard_normal(cn) * np.exp(-tvec(cn) / 0.0005)
            x = resonator(x, f * (1 + 0.04 * j), 4)
            i = i0 + ns(j * 0.011)
            out[:, i:i + cn] += pan(x * 0.4 * (1 - j / (k + 1)), p0 + (p1 - p0) * j / k)
    return out


def snap(label):
    """the brain's lights snapping onto the silicon grid."""
    rng = rng_for('snap|' + label)
    n = ns(0.6)
    t = tvec(n)
    tr = bp(rng.standard_normal(n), 1500, 12000, 2) * np.exp(-t / 0.0015)
    f = 80 + 1400 * np.exp(-t / 0.012)
    ch = np.sin(phase_of(f)) * np.exp(-t / 0.05)
    crunch = rng.standard_normal(n)
    idx = (np.floor(np.arange(n) / 9) * 9).astype(int)
    crunch = np.round(crunch[idx] * 3) / 3 * np.exp(-t / 0.035)
    crunch = bp(crunch, 600, 9000, 2)
    th = np.sin(TAU * 55 * t) * np.exp(-t / 0.12) * (1 - np.exp(-t / 0.003))
    y = 1.2 * tr + 0.5 * ch + 0.35 * crunch + 0.9 * th
    return y / np.max(np.abs(y))


def mains_hum(n, t0, label, fund=50.0):
    """mains / transformer hum: 50 Hz harmonic series with gentle grid drift."""
    rng = rng_for('mains|' + label)
    t = t0 + tvec(n)
    drift = 0.03 * smooth_noise(n, 0.05, rng)
    ph = TAU * fund * t + TAU * np.cumsum(drift) / SR
    amps = {1: 0.6, 2: 1.0, 3: 0.55, 4: 0.42, 5: 0.3, 6: 0.26, 7: 0.15, 8: 0.12, 9: 0.09, 10: 0.07,
            12: 0.05, 14: 0.035, 16: 0.025, 18: 0.02, 20: 0.015, 24: 0.01, 30: 0.006, 36: 0.004}
    y = np.zeros(n)
    for k, a in amps.items():
        y += a * np.sin(k * ph + k * 0.7)
    return y / 2.5


def fan_noise(n, label):
    """server fans: shaped noise + blade-pass tones of several fans (stereo)."""
    rng = rng_for('fans|' + label)
    t = tvec(n)
    out = np.zeros((2, n))
    for ch in range(2):
        x = colored(n, rng, -2.5)
        x = bp(x, 60.0, 9000.0, 2)
        x = eq(x, [('peak', 450.0, 0.8, 5.0), ('peak', 1600.0, 1.0, 2.0), ('highshelf', 5000.0, 0.7, -6.0)])
        x *= 1 + 0.07 * smooth_noise(n, 0.4, rng)
        y = x * 0.5
        for k in range(4):
            bpf = rng.uniform(380, 460) * (1 + 0.002 * smooth_noise(n, 0.08, rng))
            ph = np.cumsum(TAU * bpf) / SR
            y += 0.035 * (np.sin(ph) + 0.4 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph)) * (1 + 0.3 * smooth_noise(n, 0.3, rng))
        y += 0.5 * lp(colored(n, rng, -3.0), 110.0, 2)  # air-handling rumble
        out[ch] = y
    return out / (np.max(np.abs(out)) + 1e-12)


def coil_whine(n, t0, label, load=None):
    rng = rng_for('coil|' + label)
    t = t0 + tvec(n)
    f1 = 11240.0 * (1 + 0.0015 * smooth_noise(n, 0.3, rng))
    f2 = 7480.0 * (1 + 0.002 * smooth_noise(n, 0.3, rng))
    y = np.sin(np.cumsum(TAU * f1) / SR) + 0.6 * np.sin(np.cumsum(TAU * f2) / SR)
    if load is not None:
        y *= load
    return y * 0.5


def glitch(label, dur=0.7):
    """HUD failing: stuttered, bit-crushed slices."""
    rng = rng_for('glitch|' + label)
    n = ns(dur)
    out = np.zeros(n)
    i = 0
    while i < n - ns(0.01):
        L = ns(rng.uniform(0.012, 0.05))
        kind = rng.integers(0, 3)
        tt = tvec(L)
        if kind == 0:
            seg = np.sign(np.sin(TAU * rng.uniform(300, 3000) * tt)) * 0.5
        elif kind == 1:
            seg = rng.standard_normal(L) * 0.5
        else:
            seg = np.zeros(L)
        hold = rng.integers(2, 24)
        idx = (np.arange(L) // hold) * hold
        seg = seg[idx]
        seg = fade_edges(seg, 0.0008, 0.0008)
        reps = rng.integers(1, 4)
        for _ in range(reps):
            if i + L > n:
                break
            out[i:i + L] += seg * rng.uniform(0.3, 1.0)
            i += L
        i += ns(rng.uniform(0.0, 0.03))
    out = lp(out, 9000.0, 2)
    return out * np.linspace(1, 0.3, n)


def hud_blip(label, kind='line'):
    rng = rng_for('hud|' + label)
    if kind == 'line':
        n = ns(0.25)
        t = tvec(n)
        f = 2100 + 500 * np.clip(t / 0.04, 0, 1)
        y = np.sin(phase_of(f)) * np.exp(-t / 0.03) * (1 - np.exp(-t / 0.001))
        t2 = np.clip(t - 0.06, 0, None)
        y += 0.6 * np.sin(TAU * 3150 * t2) * np.exp(-t2 / 0.025) * (t > 0.06)
        return y * 0.5
    # text: a short burst of soft ticks
    n = ns(0.6)
    y = np.zeros(n)
    k = rng.integers(7, 12)
    for j in range(k):
        i = ns(0.03 + j * 0.038 + rng.uniform(-0.004, 0.004))
        c = tick(f'{label}{j}', f=rng.choice([3520.0, 4186.0, 4699.0]), dur=0.03)
        y[i:i + len(c)] += c * rng.uniform(0.5, 1.0)
    return y * 0.4


def relay_thunk(label):
    rng = rng_for('relay|' + label)
    n = ns(0.5)
    t = tvec(n)
    f = 55 + 70 * np.exp(-t / 0.015)
    low = np.sin(phase_of(f)) * np.exp(-t / 0.07) * (1 - np.exp(-t / 0.0008))
    clk = bp(rng.standard_normal(n), 1500, 7000, 2) * np.exp(-t / 0.0018)
    met = sum(a * np.sin(TAU * fr * t) * np.exp(-t / d) for fr, a, d in
              [(870, 0.3, 0.05), (1430, 0.22, 0.035), (2230, 0.15, 0.025), (3710, 0.08, 0.015)])
    body = lp(rng.standard_normal(n), 400, 2) * np.exp(-t / 0.03)
    y = 1.0 * low + 0.9 * clk + 0.5 * met + 0.6 * body
    return y / np.max(np.abs(y))


# ----------------------------------------------------------------------------
# fire
# ----------------------------------------------------------------------------
def flame(n, label, crackle_rate=0.9, size=1.0, flicker=None):
    """Close-miked candle flame: soft hiss, low turbulent flutter, wick crackles.
    Returns (mono, flicker_control)."""
    rng = rng_for('flame|' + label)
    if flicker is None:
        c1 = smooth_noise(n, 8.0, rng)
        c2 = smooth_noise(n, 0.9, rng)
        flicker = np.clip(1 + 0.17 * c1 + 0.2 * c2, 0.3, None)
    hiss = bp(rng.standard_normal(n), 600.0, 7500.0, 2)
    hiss = eq(hiss, [('peak', 2600.0, 0.8, 3.0), ('highshelf', 6000.0, 0.7, -4.0)]) * flicker ** 1.5
    puffs = np.clip(smooth_noise(n, 13.0, rng) + 0.3, 0, None)
    flut = hp(lp(rng.standard_normal(n), 170.0 * size, 2), 30.0, 2) * (0.3 + puffs) * flicker
    body = bp(rng.standard_normal(n), 140.0, 900.0, 2) * flicker
    y = 0.45 * hiss + 1.0 * flut + 0.35 * body
    # crackles
    cr = np.zeros(n)
    dur = n / SR
    cn = ns(0.025)
    k = rng.poisson(crackle_rate * dur)
    for _ in range(k):
        i0 = rng.integers(0, max(1, n - ns(0.08)))
        for j in range(rng.choice([1, 1, 1, 2, 3])):
            i = i0 + ns(rng.uniform(0, 0.04)) * (j > 0)
            if i + cn >= n:
                continue
            x = rng.standard_normal(cn) * np.exp(-tvec(cn) / rng.uniform(0.0004, 0.0025))
            x = resonator(x, rng.uniform(1400, 6500), rng.uniform(1.5, 5))
            cr[i:i + cn] += x * min(rng.lognormal(0, 0.5), 2.0) * 0.45
    y = y + cr
    return y, flicker


def match_strike(label, dur=2.4):
    """scrape -> phosphor crack -> flare whoosh -> sparks -> small match flame. stereo."""
    rng = rng_for('match|' + label)
    n = ns(dur)
    t = tvec(n)
    out = np.zeros((2, n))
    # scrape 0..0.17 s: rough granular friction
    ns_ = ns(0.19)
    ts = tvec(ns_)
    rough = np.abs(smooth_noise(ns_, 140.0, rng)) + 0.6 * (rng.random(ns_) < 0.004)
    rough = np.convolve(rough, np.ones(24) / 24, 'same')
    sc = bp(rng.standard_normal(ns_), 1400.0, 8000.0, 2) * rough
    sc *= np.clip(ts / 0.17, 0, 1) ** 0.6 * (1 - np.exp(-ts / 0.004))
    sc += 0.5 * bp(rng.standard_normal(ns_), 300.0, 1500.0, 2) * rough * 0.5
    sc = fade_edges(sc, 0.002, 0.01)
    out[:, :ns_] += pan(sc * 0.9, -0.08)
    # phosphor crack + fizz
    i0 = ns(0.165)
    m = n - i0
    tm = tvec(m)
    crack = bp(rng.standard_normal(m), 1000, 11000, 2) * np.exp(-tm / 0.003) * 1.4
    fizz = hp(rng.standard_normal(m), 2500.0, 2) * np.exp(-tm / 0.18) * (1 - np.exp(-tm / 0.005))
    fizz *= 1 + 0.8 * (rng.random(m) < 0.02)
    # flare whoosh: spectrum opens then settles
    def G(tt, ff):
        fc = 700 + 6500 * np.exp(-((tt - 0.12) / 0.12) ** 2) + 1300 * (tt > 0.12)
        return 1 / np.sqrt(1 + (ff / fc) ** 4)
    flare = stft_shape(rng.standard_normal(m), G, 1024)
    fe = (1 - np.exp(-tm / 0.03)) * (np.exp(-tm / 0.35) * 0.9 + 0.12 * np.exp(-tm / 1.5))
    flare *= fe
    whump = bp(rng.standard_normal(m), 60.0, 260.0, 2) * (1 - np.exp(-tm / 0.02)) * np.exp(-tm / 0.22)
    mono = 0.7 * crack + 0.35 * fizz + 0.9 * flare + 1.3 * whump
    out[:, i0:] += widen(mono, label + 'flare', 0.5)
    # sparks
    cn = ns(0.02)
    for s in range(rng.integers(10, 15)):
        ii = i0 + ns(rng.uniform(0.0, 0.7))
        x = rng.standard_normal(cn) * np.exp(-tvec(cn) / rng.uniform(0.0003, 0.0012))
        x = resonator(x, rng.uniform(3000, 9000), 3)
        out[:, ii:ii + cn] += pan(x * rng.uniform(0.2, 0.6), rng.uniform(-0.7, 0.7))
    # small steady match flame, fading
    fl, _ = flame(m, label + 'mf', crackle_rate=2.0)
    fl *= (1 - np.exp(-tm / 0.15)) * np.exp(-tm / 2.5) * 0.6
    out[:, i0:] += pan(fl, 0.0)
    out = fade_edges(out, 0.0, 0.3)
    return out / np.max(np.abs(out))


def flame_catch(label):
    """the flame settling on the wick: a soft 'fwump' bloom."""
    rng = rng_for('catch|' + label)
    n = ns(0.9)
    t = tvec(n)
    y = bp(rng.standard_normal(n), 90.0, 1200.0, 2) * (1 - np.exp(-t / 0.05)) * np.exp(-t / 0.22)
    y += 0.3 * bp(rng.standard_normal(n), 1500, 6000, 2) * (1 - np.exp(-t / 0.03)) * np.exp(-t / 0.12)
    return y / np.max(np.abs(y))


def tss(label):
    """dandelion seed touching the flame: tiny bright hiss, pop, wisp of smoke."""
    rng = rng_for('tss|' + label)
    n = ns(1.0)
    t = tvec(n)
    hiss = hp(rng.standard_normal(n), 4000.0, 2) * (1 - np.exp(-t / 0.004)) * np.exp(-t / 0.09)
    pop = bp(rng.standard_normal(n), 1500.0, 9000.0, 2) * np.exp(-t / 0.0012)
    smoke = bp(rng.standard_normal(n), 400.0, 2500.0, 2) * (1 - np.exp(-t / 0.05)) * np.exp(-t / 0.35) * 0.25
    y = hiss + 0.8 * pop + smoke
    return fade_edges(y / np.max(np.abs(y)), 0.0, 0.2)


def drip(label):
    rng = rng_for('drip|' + label)
    n = ns(0.3)
    t = tvec(n)
    f = 420 + 520 * np.exp(-t / 0.012)
    y = np.sin(phase_of(f)) * np.exp(-t / 0.035) * (1 - np.exp(-t / 0.002))
    y += 0.15 * lp(rng.standard_normal(n), 900, 2) * np.exp(-t / 0.01)
    return y


def wind_gust(dur, label, pan_from=-0.6, pan_to=0.6):
    rng = rng_for('wind|' + label)
    n = ns(dur)
    t = tvec(n)
    x = t / dur

    def fc(tt):
        xx = np.clip(tt / dur, 0, 1)
        return 220 * (1 + 2.0 * np.sin(np.pi * xx) ** 2)

    y = sweep_band(n, rng, fc, lambda tt: 1.1 + 0 * tt)
    y *= np.sin(np.pi * x) ** 2 * (1 + 0.3 * smooth_noise(n, 1.5, rng))
    y /= np.max(np.abs(y)) + 1e-12
    return pan(y, pan_from + (pan_to - pan_from) * x) + widen(y, label, 1.0) * 0.4


def ember_stroke(dur, label, p=0.0):
    """a stroke written in embers: soft warm hiss + fine crackle, swelling."""
    rng = rng_for('ember|' + label)
    n = ns(dur)
    t = tvec(n)
    x = t / dur
    h = bp(rng.standard_normal(n), 1500, 7000, 2) * 0.3
    w = bp(rng.standard_normal(n), 150, 900, 2) * 0.5
    cr = np.zeros(n)
    cn = ns(0.01)
    for _ in range(rng.poisson(40 * dur)):
        i = rng.integers(0, n - cn)
        c = rng.standard_normal(cn) * np.exp(-tvec(cn) / 0.0006)
        cr[i:i + cn] += resonator(c, rng.uniform(2500, 8000), 3) * rng.uniform(0.1, 0.5)
    y = (h + w + cr) * np.sin(np.pi * np.clip(x, 0, 1)) ** 1.2
    return pan(y, p)
