#!/usr/bin/env python3
"""XIN -- complete synthesised score + sound design.

    python3 /home/user/utanote/film/audio/score.py

Reads every sync point from film/timeline.json (cues, cards, events) and writes
film/out/score.wav (48 kHz / 24-bit / stereo, exactly timeline.duration long),
stems in film/out/stems/ (32-bit float) and QA plots/report in film/out/qa/.
Deterministic: all randomness comes from seeded generators (dsp.rng_for).
"""
import json
import os
import sys
import time

import numpy as np
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from dsp import (SR, TAU, ns, tvec, hz, midi, db, rng_for, env_pts, ar_env, ease, fade_edges, lp, hp, bp,
                 eq, pan, widen, decorrelate, digitize, frac_delay, make_ir, t60_curve, convolve_stereo,
                 smooth_noise, blep_saw)
import instruments as I
import fx as X
import master as M

FILM = os.path.dirname(HERE)
OUT = os.path.join(FILM, 'out')
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:6.1f}s]', *a, flush=True)


# =============================================================================
# mixer
# =============================================================================
class Mixer:
    STEMS = ('music', 'sfx', 'ambience')
    SENDS = {'music': ('hall', 'space'), 'sfx': ('room', 'hall', 'space'), 'ambience': ('room', 'hall')}

    def __init__(self, dur, groups):
        self.N = ns(dur)
        self.groups = groups
        z = lambda: np.zeros((2, self.N), np.float32)
        self.dry = {s: z() for s in self.STEMS}
        self.snd = {(s, r): z() for s in self.STEMS for r in self.SENDS[s]}
        self.post = {s: np.ones(self.N, np.float32) for s in self.STEMS}
        self.strings = z()
        self.choir = z()
        self.warn = []

    def group_end(self, t):
        for a, b in self.groups:
            if a - 1e-9 <= t < b:
                return b
        return None

    def add(self, stem, t0, sig, gain_db=0.0, p=0.0, sends=None, bus=None):
        sig = np.asarray(sig, dtype=float)
        if sig.ndim == 1:
            sig = pan(sig, p)
        ge = self.group_end(t0)
        if ge is None:
            self.warn.append(f'event at {t0:.3f}s outside any audible group -> dropped')
            return
        i0 = ns(t0)
        i1 = min(i0 + sig.shape[1], ns(ge), self.N)
        if i1 <= i0:
            return
        seg = sig[:, :i1 - i0] * db(gain_db)
        tgt = self.dry[stem] if bus is None else bus
        tgt[:, i0:i1] += seg
        if sends and bus is None:
            for r, a in sends.items():
                self.snd[(stem, r)][:, i0:i1] += seg * a

    def automate(self, stems, pts):
        """multiply post-reverb gain of stems by a dB envelope over [pts[0].t, pts[-1].t]"""
        ta, tb = pts[0][0], pts[-1][0]
        i0, i1 = ns(ta), min(ns(tb), self.N)
        e = env_pts(i1 - i0, [(t - ta, v) for t, v in pts], in_db=True).astype(np.float32)
        for s in stems:
            self.post[s][i0:i1] *= e

    def add_bus(self, stem, y, i0, sends):
        """add a processed bus slice starting at sample i0; sends values scalar or arrays"""
        i1 = i0 + y.shape[1]
        self.dry[stem][:, i0:i1] += y
        for r, a in sends.items():
            self.snd[(stem, r)][:, i0:i1] += y * a

    def render(self, irs):
        out = {s: np.zeros((2, self.N), np.float32) for s in self.STEMS}
        for a, b in self.groups:
            i0, i1 = ns(a), min(ns(b), self.N)
            for s in self.STEMS:
                y = self.dry[s][:, i0:i1].astype(np.float64)
                for r in self.SENDS[s]:
                    x = self.snd[(s, r)][:, i0:i1]
                    if not np.any(x):
                        continue
                    y += convolve_stereo(x.astype(np.float64), irs[r])
                y *= self.post[s][i0:i1]
                out[s][:, i0:i1] = y
            log(f'  group {a:7.2f}-{b:7.2f} rendered')
        return out


def nz_span(x, pad=0):
    idx = np.flatnonzero(np.any(x != 0, axis=0))
    if idx.size == 0:
        return None
    return max(0, idx[0] - pad), min(x.shape[1], idx[-1] + 1 + pad)


def Adb(n, t0, pts):
    """absolute-time dB envelope for a signal starting at absolute t0"""
    return env_pts(n, [(t - t0, v) for t, v in pts], in_db=True)


def Alin(n, t0, pts):
    return env_pts(n, [(t - t0, v) for t, v in pts])


# =============================================================================
# instrument helpers bound to the mixer
# =============================================================================
def strings(mx, note, t0, t1, att=1.5, rel=1.5, gain=0.0, p=0.0, voices=3, spread=0.5, label='',
            env=None, fcurve=None, vib=9.0):
    n = ns(t1 - t0 + rel)
    fc = None
    if fcurve is not None:
        fc = fcurve(t0 + tvec(n))
    raw = I.section_note(note, n, f'{label}{t0:.3f}', voices=voices, pan0=p, spread=spread, fcurve=fc,
                         vib_cents=vib)
    e = ar_env(n, att, rel) if env is None else Adb(n, t0, env)
    mx.add('music', t0, raw * e, gain, bus=mx.strings)


def chord(mx, notes, t0, t1, att=1.5, rel=1.5, gain=0.0, spread=0.9, label='ch', env=None, voices=3):
    k = len(notes)
    for i, nt in enumerate(notes):
        p = (i / max(1, k - 1) * 2 - 1) * spread * 0.6 if k > 1 else 0.0
        if midi(nt) < 50:
            p *= 0.3
        strings(mx, nt, t0, t1, att, rel, gain - 10 * np.log10(k), p, voices, 0.45, label + nt, env)


def pno(mx, t, note, vel, ring=6.0, held=None, gain=0.0, p=0.0, sends=None, label='p'):
    y = I.piano(note, ring - 0.4 if held is None else held, vel, label=f'{label}{t:.3f}', ring=ring)
    pp = float(np.clip((midi(note) - 62) / 60.0, -0.3, 0.3)) + p
    mx.add('music', t, y, gain, pp, sends if sends is not None else {'hall': 0.3})


def choir_note(mx, note, t0, t1, env, p=0.0, gain=0.0):
    n = ns(t1 - t0)
    y = I.choir_source(note, n, phase0=0.0) * Adb(n, t0, env)
    mx.add('music', t0, y, gain, p, bus=mx.choir)


def grain_cloud(mx, stem, t_start, t_end, rate_fn, pool, label, dur_rng=(0.02, 0.09), amp_db=(-36, -28),
                pan_rng=0.9, sends=None, gain=0.0, quant=None, amp_fn=None, shape='hann', crush=None):
    rng = rng_for('cloud|' + label)
    n = ns(t_end - t_start + 0.6)
    buf = np.zeros((2, n))
    t = t_start
    while True:
        t += rng.exponential(1.0 / max(rate_fn(t), 1e-3))
        if t >= t_end:
            break
        tq = t if quant is None else t_start + round((t - t_start) / quant) * quant
        f = hz(rng.choice(pool)) * 2 ** (rng.normal(0, 3) / 1200)
        d = rng.uniform(*dur_rng)
        a = db(rng.uniform(*amp_db)) * (amp_fn(t) if amp_fn else 1.0)
        g = X.grain(f, d, shape)
        if crush:
            g = digitize(g, crush[0], crush[1], ref=1.0)
        i = ns(tq - t_start)
        if i + len(g) > n:
            continue
        pr = pan_rng(t) if callable(pan_rng) else pan_rng
        buf[:, i:i + len(g)] += pan(g * a, rng.uniform(-pr, pr))
    mx.add(stem, t_start, buf, gain, sends=sends)


def tempo_times(t_start, t_end, period_fn):
    out, t = [], t_start
    while t < t_end:
        out.append(t)
        t += period_fn(t)
    return out


# =============================================================================
# the score
# =============================================================================
def build(tl):
    C = tl['cues']
    E = tl.get('events', {})
    D = float(tl['duration'])
    windows = silence_windows(tl)
    groups = [(C['silence_end'], C['hum_cut']),
              (C['match_strike'] - 0.05, C['cut_black']),
              (C['stars_return'] - 0.5, C['session_log_in']),
              (C['end_match_strike'], min(D, C['end_fade'] + 0.5))]
    mx = Mixer(D, groups)
    # automation of the strings bus (brightness and sends), absolute time
    s_bright, s_space = [(0.0, 0.25)], [(0.0, 0.45)]

    # -------------------------------------------------------------------------
    # PROLOGUE  (black -> constellation -> drift)
    # -------------------------------------------------------------------------
    log('prologue')
    t_on = C['silence_end']
    LAND = C['drift_start']                      # the fly-through decelerates into a calm drift here
    REL = C['astra_release']
    COL = C['collapse_start']
    ign = E.get('astra_star_ignitions', [C['first_star']])
    ticks = E.get('astra_line_ticks', list(np.linspace(C['astra_lines_start'], C['astra_lines_end'], 14)))

    # sub drone D1, from below threshold, carried through the drift into the collapse
    t1 = COL + 3.0
    n = ns(t1 - t_on)
    tt = t_on + tvec(n)
    d1 = hz('D1')
    oct_w = np.interp(tt, [t_on, REL, LAND, COL], [0.25, 0.3, 0.8, 0.45])
    drone = (np.sin(TAU * d1 * tt) + 0.8 * np.sin(TAU * d1 * 1.0034 * tt + 1.0)
             + oct_w * np.sin(TAU * 2 * d1 * tt + 0.3) + 0.12 * np.sin(TAU * 3 * d1 * tt))
    drone = np.tanh(1.3 * drone) * (1 + 0.08 * np.sin(TAU * 0.07 * tt))
    drone = lp(drone, 260.0, 2)
    drone *= Adb(n, t_on, [(t_on, -110), (C['first_star'], -54), (C['astra_lines_start'], -40),
                           (C['astra_hold_start'], -33), (REL, -31), (LAND - 0.05, -21), (LAND + 0.8, -23),
                           (COL, -24), (COL + 2.0, -32), (t1, -110)])
    mx.add('music', t_on, drone, 0.0, 0.0, {'space': 0.08})
    # one thread of high glass
    n = ns(LAND + 1.5 - 1.5)
    g = I.glass('D7', n, 'pro1', beat=0.31) + 0.35 * I.glass('A7', n, 'pro2', beat=0.17)
    g *= Adb(n, 1.5, [(1.5, -110), (C['first_star'], -47), (C['astra_hold_start'], -42), (REL, -44),
                      (LAND - 1, -52), (LAND + 1.5, -110)])
    mx.add('music', 1.5, g, 0.0, np.sin(TAU * 0.03 * tvec(n)) * 0.25, {'space': 0.7})

    # first star 'ting' + anamorphic air streak
    t = ign[0]
    mx.add('music', t, I.ting('A6', 6.0, 'first'), -25.0, -0.35, {'space': 0.55})
    air = X.whoosh(1.8, 'flare1', peak=0.12, f_lo=3500, f_hi=9000, width_oct=0.8, pan_from=-0.5, pan_to=0.3)
    mx.add('sfx', t, air, -40.0, sends={'space': 0.4})
    # hero stars of the constellation: delicate pings inside the shimmer
    pool = ['E6', 'A6', 'D7', 'B6', 'E7', 'G6', 'A7', 'C7', 'D7', 'E6', 'A6', 'G7']
    prng = rng_for('heropan')
    for k, t in enumerate(ign[1:]):
        f = hz(pool[k % len(pool)])
        mx.add('music', t, X.star_ping(f, f'hero{k}'), -31.0 - 0.15 * k, prng.uniform(-0.7, 0.7),
               {'space': 0.4})
    # granular shimmer: accelerating with the stars, then a living star field
    a0, a1 = C['stars_accel_start'], C['stars_accel_end']
    spool = ['D6', 'E6', 'G6', 'A6', 'B6', 'C7', 'D7', 'E7', 'G7', 'A7', 'D8']

    def srate(t):
        if t < a0:
            return 1.0
        if t < a1:
            return 3.0 * (40.0 / 3.0) ** ((t - a0) / (a1 - a0))
        return max(2.0, 40.0 * np.exp(-(t - a1) / 1.2))

    grain_cloud(mx, 'music', a0 - 0.6, LAND + 0.5, srate, spool, 'stars', (0.02, 0.09), (-52, -44), 0.9,
                {'space': 0.75}, amp_fn=lambda t: 1.0 if t < LAND - 2 else max(0.0, (LAND + 0.5 - t) / 2.5))
    # constellation strokes: one soft tick each
    tpool = ['A7', 'E7', 'D7', 'A7', 'B7', 'E7', 'D8', 'A7', 'E7', 'G7', 'A7', 'D8', 'E7', 'A7']
    for k, t in enumerate(ticks):
        p = -0.55 + 1.1 * k / max(1, len(ticks) - 1)
        mx.add('sfx', t, X.tick(f'astra{k}', hz(tpool[k % len(tpool)])), -25.0, p, {'space': 0.3})
    # soft open-fifth glass pad under the wordmark
    ta = C['astra_lines_start'] - 0.2
    n = ns(LAND - ta)
    pad = I.glass('D5', n, 'apad1', beat=0.4) + 0.8 * I.glass('A5', n, 'apad2', beat=0.27)
    pad *= Adb(n, ta, [(ta, -110), (C['astra_lines_end'], -37), (REL, -38), (LAND - 1.0, -50), (LAND, -110)])
    mx.add('music', ta, widen(pad, 'apad'), 0.0, sends={'space': 0.6})
    # the glare sweeping across the hold
    hs, he = C['astra_hold_start'], C['astra_hold_end']
    mx.add('sfx', hs, X.whoosh(he - hs, 'glare', peak=0.5, f_lo=2200, f_hi=7500, width_oct=1.0,
                               pan_from=-0.85, pan_to=0.85), -39.0, sends={'space': 0.4})
    # release: stars stream past, reverse swell + riser into the drift
    mx.add('sfx', REL, X.reverse_swell(LAND - REL, 'rel'), -23.5, sends={'space': 0.12})
    mx.add('music', REL, X.riser_tone(LAND - REL, 'rel', hz('A4'), hz('D6')), -28.0, sends={'space': 0.4})
    passes = [(REL + 0.35, 1.0, -1), (REL + 0.9, 0.85, 1), (REL + 1.35, 0.7, -1), (REL + 1.72, 0.6, 1),
              (REL + 2.02, 0.55, -1), (REL + 2.3, 0.6, 1)]
    for k, (t, d, side) in enumerate(passes):
        w = X.whoosh(d, f'pass{k}', peak=0.45, f_lo=700, f_hi=5500, width_oct=0.9,
                     pan_from=0.15 * side, pan_to=0.95 * side)
        mx.add('sfx', t, w, -30.0 + 1.2 * k, sends={'space': 0.25})
    mx.add('sfx', REL + 0.9, X.whoosh(2.4, 'flythru', peak=0.58, f_lo=160, f_hi=2600, width_oct=1.4,
                                      pan_from=-0.2, pan_to=0.2), -24.0, sends={'space': 0.3})
    # drift: no motif - a soft bowed fifth blooms, embers rise and are drawn away into the collapse
    for nt, p in (('D2', -0.15), ('A2', 0.15), ('D3', 0.0)):
        strings(mx, nt, LAND, COL + 1.5, att=1.8, rel=1.5, gain=-29.0, p=p, label='drift')
    s_bright += [(LAND, 0.15), (COL - 0.2, 0.15)]
    mx.add('sfx', LAND + 0.6, X.ember_stroke(COL - LAND + 0.6, 'drift', 0.1), -33.0, sends={'space': 0.45})
    grain_cloud(mx, 'music', LAND + 0.4, COL + 1.0, lambda t: 5.0, ['A5', 'D6', 'E6', 'A6'], 'embers',
                (0.03, 0.12), (-45, -38), lambda t: 0.3 + 0.5 * np.clip((t - LAND) / 4.0, 0, 1), {'space': 0.6})
    mx.add('sfx', COL - 1.6, X.whoosh(3.2, 'drawn', peak=0.6, f_lo=200, f_hi=1400, width_oct=1.3,
                                      pan_from=0.3, pan_to=-0.1, attack_pow=2.5), -31.0, sends={'space': 0.3})

    # -------------------------------------------------------------------------
    # ACT I - HEAT (one take, 40 s)
    # -------------------------------------------------------------------------
    log('act I')
    IMP, IGN = C['implode'], C['ignite']
    span = IMP - COL
    ost0 = C['ch1_in'] + 0.5
    # ostinato: accelerating 8ths (Kepler spin-up)
    p0, p1 = 0.40, 0.19
    per = lambda t: p0 * (p1 / p0) ** (np.clip((t - ost0) / (IMP - ost0), 0, 1) ** 1.2)
    otimes = tempo_times(ost0, IMP - 0.12, per)
    patt = ['D2', 'D2', 'A2', 'D2', 'D2', 'D2', 'Bb2', 'A2']
    for k, t in enumerate(otimes):
        nt = patt[k % 8]
        x = np.clip((t - ost0) / (IMP - ost0), 0, 1)
        nn = ns(0.39)
        tt_ = tvec(nn)
        acc = 1.0 if k % 4 == 0 else 0.72
        amp = (1 - np.exp(-tt_ / 0.006)) * np.exp(-tt_ / (0.07 + 0.05 * (1 - x))) * acc
        f = np.full(nn, hz(nt)) * 2 ** (rng_for(f'o{k}').normal(0, 3) / 1200)
        y = I.bowed(f, amp, np.full(nn, 0.25 + 0.45 * x), f'ost{k}', noise=0.05)
        y += 0.5 * np.sin(TAU * hz(nt) / 2 * tt_) * amp * (0.4 + 0.6 * x)
        gdb = -31.0 + 13.0 * x ** 0.8
        mx.add('music', t, y, gdb, 0.0, {'hall': 0.25})
        if x > 0.45:   # octave layer joins, panned pair
            y2 = I.bowed(f * 2, amp, np.full(nn, 0.35 + 0.4 * x), f'osu{k}', noise=0.06)
            mx.add('music', t, y2, gdb - 7.0, 0.3 if k % 2 else -0.3, {'hall': 0.3})
    # rumble swirling faster as the disk spins (enters under the cross-fade from the drift)
    r_in = COL - 0.8
    n = ns(IMP + 0.1 - r_in)
    rum = X.rumble(n, 'collapse', lambda t: 55.0 * (500.0 / 55.0) ** np.clip(t / (IMP - r_in), 0, 1) ** 1.5,
                   lambda t: 0.08 + 1.3 * (t / (IMP - r_in)) ** 2)
    rum *= Adb(n, r_in, [(r_in, -110), (C['ch1_out'], -36), (COL + 0.6 * span, -29), (IMP - 0.05, -19.5),
                         (IMP + 0.1, -110)])
    mx.add('ambience', r_in, rum, 0.0, sends={'hall': 0.15})
    # low string pad crescendo, heat brightening (dark red -> white)
    pend = IMP + 0.3
    envL = [(COL + 0.3, -110), (COL + 2.5, -30), (IMP - 0.4, -13), (IMP + 0.3, -110)]
    strings(mx, 'D2', COL + 0.3, pend, env=envL, gain=-19.0, p=-0.1, label='colD')
    strings(mx, 'A2', COL + 0.3, pend, env=envL, gain=-21.0, p=0.1, label='colA')
    ta = COL + 0.35 * span
    strings(mx, 'D3', ta, pend, env=[(ta, -110), (ta + 2, -26), (IMP - 0.4, -13), (IMP + 0.3, -110)],
            gain=-22.0, p=-0.3, label='colD3')
    ta = COL + 0.5 * span
    strings(mx, 'Bb2', ta, pend, env=[(ta, -110), (ta + 1.5, -28), (IMP - 0.4, -15), (IMP + 0.3, -110)],
            gain=-23.0, p=0.3, label='colBb')
    # tension: high strings glissando upward (accelerating)
    r0 = COL + 0.2 * span
    gl = lambda f0, f1: (lambda t: f0 * (f1 / f0) ** (np.clip((t - r0) / (IMP - r0), 0, 1) ** 1.7))
    envR = [(r0, -110), (r0 + 1.5, -30), (IMP - 0.3, -11), (IMP + 0.3, -110)]
    strings(mx, 'A4', r0, pend, env=envR, gain=-24.0, p=0.35, label='rise1', fcurve=gl(hz('A4'), hz('D6')), voices=4)
    strings(mx, 'D4', r0, pend, env=envR, gain=-26.0, p=-0.35, label='rise2', fcurve=gl(hz('D4'), hz('G5')), voices=4)
    s_bright += [(COL, 0.08), (IMP, 0.85)]
    s_space += [(COL - 0.5, 0.45), (COL + 2, 0.15), (IMP, 0.15)]

    # IMPLOSION: suck-out, then vacuum
    mx.add('sfx', IMP, X.suck_out(0.36, 'imp'), -13.0, sends={'room': 0.05})
    mx.automate(['music', 'ambience'], [(IMP, 0), (IMP + 0.08, -6), (IMP + 0.33, -75), (IGN - 0.002, -75), (IGN, 0)])
    mx.automate(['sfx'], [(IMP + 0.34, 0), (IMP + 0.38, -60), (IGN - 0.002, -60), (IGN, 0)])

    # IGNITION: spectacular but held back - the film saves its peak for the end
    IG = -9.7   # common trim of the ignition relative to v1
    mx.add('sfx', IGN, X.sub_drop(6.5, 'ign'), -19.0 + IG)
    mx.add('sfx', IGN, X.boom(1.6, 'ign'), -15.0 + IG, sends={'hall': 0.15})
    mx.add('sfx', IGN, X.impact_burst(4.5, 'ign'), -13.5 + IG, sends={'space': 0.7, 'hall': 0.2})
    mx.add('sfx', IGN + 0.05, X.whoosh(2.4, 'shock', peak=0.22, f_lo=300, f_hi=6500, width_oct=1.3,
                                       pan_from=-0.9, pan_to=0.9, attack_pow=0.7), -16.0 + IG, sends={'space': 0.4})
    full = ['D2', 'A2', 'D3', 'F3', 'A3', 'E4', 'A4', 'D5', 'E5', 'A5']
    sh2 = C['star_hud_2']
    sp = [(IGN, -110), (IGN + 0.06, -3.5), (IGN + 1.0, -7), (IGN + 2.5, -10), (sh2 + 0.5, -10), (sh2 + 2.0, -110)]
    chord(mx, full, IGN, sh2 + 2.0, gain=-3.0 + IG, env=sp, label='ign')
    n = ns(9.0)
    oc = np.interp(tvec(n), [0, 0.1, 3, 9], [0.2, 1.0, 0.35, 0.15])
    br = I.brass_pad(['D2', 'A2', 'D3', 'F3', 'A3'], n, 'ign', oc)
    br *= Adb(n, IGN, [(IGN, -110), (IGN + 0.05, 0), (IGN + 3, -10), (IGN + 7, -13), (IGN + 9, -110)])
    mx.add('music', IGN, widen(br, 'brass', 0.5), -15.0 + IG, sends={'hall': 0.3, 'space': 0.35})
    n = ns(8.0)
    gl_ = I.glass('A6', n, 'ign1', beat=0.5) + I.glass('D7', n, 'ign2', beat=0.35)
    gl_ *= Adb(n, IGN, [(IGN, -110), (IGN + 0.03, -32), (IGN + 3, -40), (IGN + 8, -110)])
    mx.add('music', IGN, widen(gl_, 'ignglass'), 0.0, sends={'space': 0.8})
    PB = C['pullback_start']
    s_bright += [(IGN - 0.01, 0.85), (IGN, 1.0), (IGN + 3, 0.65), (PB, 0.55)]
    s_space += [(IGN - 0.01, 0.15), (IGN, 0.55), (PB, 0.4)]

    # the star: plasma roar + broad string pad; classification table typed line by line
    n = ns(PB + 1.5 - (IGN + 0.1))
    pl = X.plasma(n, 'star')
    pl *= Adb(n, IGN + 0.1, [(IGN + 0.1, -110), (IGN + 1.5, -28), (PB - 1, -29), (PB + 1.5, -110)])
    mx.add('ambience', IGN + 0.1, pl, 0.0, sends={'hall': 0.12})
    bb = ['Bb1', 'F2', 'Bb2', 'D3', 'A3', 'C4', 'F4', 'A4', 'D5']
    chord(mx, bb, sh2 - 0.3, PB + 0.8, att=2.2, rel=1.8, gain=-18.0, label='bb')
    EA, SU, CD, BF = C['earth_arrive'], C['sunrise'], C['city_dive'], C['brain_form']
    chord(mx, ['C2', 'G2', 'C3', 'G3', 'D4', 'G4', 'C5'], PB, EA + 0.3, att=1.2, rel=1.0, gain=-18.5, label='csus')

    def table(t, label, lines=3, gap=0.65, p=-0.3, g=-31.0):
        mx.add('sfx', t, X.hud_blip(label + 'L', 'line'), g - 1.0, p, {'room': 0.2})
        for j in range(lines):
            mx.add('sfx', t + 0.15 + j * gap, X.hud_blip(f'{label}{j}', 'text'), g, p, {'room': 0.2})

    table(C['star_hud_1'], 'sun', 1)
    table(sh2, 'sun2', 2, p=-0.3)

    # pull-back: the film's only fast move
    mx.add('sfx', PB - 0.3, X.whoosh(3.8, 'pullback', peak=0.35, f_lo=140, f_hi=2600, width_oct=1.4,
                                     pan_from=-0.35, pan_to=0.35, attack_pow=1.3), -20.0, sends={'hall': 0.3})
    n = ns(BF - PB)
    ab = X.air_bed(n, 'earth')
    ab *= Adb(n, PB, [(PB, -110), (PB + 1.5, -40), (EA, -35), (CD, -37), (BF, -110)])
    mx.add('ambience', PB, ab, 0.0, sends={'hall': 0.3})
    # modulation to the Dorian IV: G/D, the living B natural
    chord(mx, ['D2', 'G2', 'D3', 'B3', 'D4', 'A4', 'B4', 'G5'], EA, CD + 0.6, att=1.0, rel=1.4, gain=-18.0,
          label='earth')
    s_bright += [(EA, 0.6), (CD, 0.45), (BF, 0.3)]
    s_space += [(EA, 0.4), (CD, 0.2)]
    n = ns(5.0)
    for nt, p, dl in (('B5', -0.4, 0.0), ('D6', 0.4, 0.12), ('A6', -0.1, 0.25), ('E7', 0.2, 0.4)):
        gg = I.glass(nt, n, 'sun' + nt, beat=0.6)
        gg *= Adb(n, 0, [(0, -110), (0.25, -35), (2.0, -41), (5.0, -110)])
        mx.add('music', SU + dl, gg, 0.0, p, {'space': 0.6})
    mx.add('sfx', SU, X.whoosh(2.0, 'sunflare', peak=0.25, f_lo=3000, f_hi=10000, width_oct=0.8,
                               pan_from=-0.6, pan_to=0.6), -37.0, sends={'space': 0.4})
    mx.add('sfx', CD - 0.4, X.whoosh(2.4, 'dive', peak=0.7, f_lo=250, f_hi=3000, width_oct=1.2,
                                     pan_from=0.25, pan_to=-0.2), -18.0, sends={'hall': 0.25})

    # the brain: neural crackle, a first (calm) heartbeat, delicate glass pulses
    SS = C['silicon_snap']
    n = ns(SS - BF)
    ncr = X.neural_crackle(n, 'brain', rate=22.0)
    ncr *= Adb(n, BF, [(BF, -110), (BF + 1.0, -28), (SS - 0.5, -26), (SS, -110)])
    mx.add('ambience', BF, ncr, 0.0, sends={'hall': 0.25})
    hb_per = 60.0 / 62.0
    hbt = tempo_times(BF + 0.4, SS - 0.3, lambda t: hb_per)
    for k, (t, y) in enumerate(X.heartbeat(hbt, 'brain')):
        mx.add('music', t, y, -18.0, 0.0, {'hall': 0.05})
    mpool = ['A5', 'E5', 'F5', 'D5', 'C6', 'A5', 'E5', 'G5']
    for k, t in enumerate(hbt):
        for j, dt in enumerate((0.0, hb_per / 2)):
            nt = mpool[(2 * k + j) % len(mpool)]
            mx.add('music', t + dt + 0.12, I.mallet(nt, 1.6, f'm{k}{j}', soft=0.6), -27.0 - 3 * j,
                   0.4 if (k + j) % 2 else -0.4, {'hall': 0.5})
    chord(mx, ['D4', 'F4', 'A4', 'E5'], BF - 0.5, SS - 0.05, att=1.5, rel=0.25, gain=-22.0, spread=0.7, label='brain')
    table(C['brain_hud'], 'brain', 3)

    # silicon: snap to the grid -> computation arpeggio, machine hum rising
    mx.add('sfx', SS, X.snap('snap'), -12.0, sends={'hall': 0.25, 'room': 0.2})
    s_bright += [(SS - 0.1, 0.3)]
    SPK, AF, SPO, HC = C['spark_rise'], C['act1_fade'], C['spark_out'], C['hum_cut']
    DR = C['datacenter_reveal']
    sixteenth = 60.0 / 120.0 / 4
    bars = [['D4', 'F4', 'A4', 'C5', 'E5'], ['Bb3', 'D4', 'F4', 'A4', 'E5'], ['C4', 'E4', 'G4', 'A4', 'D5'],
            ['D4', 'F4', 'A4', 'C5', 'E5'], ['Bb3', 'D4', 'F4', 'A4', 'C5'], ['C4', 'E4', 'G4', 'D5', 'E5']]
    roots = ['D2', 'Bb1', 'C2', 'D2', 'Bb1', 'C2']
    patt = [0, 2, 4, 5, 7, 5, 4, 2, 1, 3, 5, 6, 8, 6, 5, 3]
    fade = lambda t: float(np.clip((t - SPK) / (AF - SPK), 0, 1))   # the heat column dissipates
    arp_onsets = []
    k = 0
    t = SS
    while t < AF - 0.05:
        bar = int((t - SS) / (16 * sixteenth))
        tones = bars[min(bar, len(bars) - 1)]
        ext = [midi(x) for x in tones] + [midi(x) + 12 for x in tones]
        idx = patt[k % 16]
        x = np.clip((t - SS) / (SPK - SS), 0, 1)
        fd = fade(t)
        if fd > 0 and idx >= 5:
            idx -= 5
        m = ext[idx]
        bright = 0.15 + 0.75 * x - 0.4 * fd
        acc = 1.0 if k % 4 == 0 else 0.75
        g = -29.5 + 6.0 * x - 18.0 * fd ** 1.3
        y = I.pluck(m, 0.6, bright, f'arp{k}')
        mx.add('music', t, y * acc, g, 0.32 if k % 2 else -0.32, {'hall': 0.3})
        if DR <= t < SPK and k % 2 == 0:
            y2 = I.pluck(m + 12, 0.35, 0.5, f'arq{k}')
            mx.add('music', t, y2, g - 9.0, -0.6 if k % 4 else 0.6, {'hall': 0.4})
        arp_onsets.append(t)
        if DR <= t and k % 2 == 0 and fd < 1:
            rt = midi(roots[min(bar, len(roots) - 1)])
            yb = I.pluck(rt, 0.4, 0.15, f'bass{k}', pw_odd=0.2)
            yb += 0.6 * np.sin(TAU * hz(rt) * tvec(len(yb))) * np.exp(-tvec(len(yb)) / 0.18)
            mx.add('music', t, yb, -20.5 - 14.0 * fd, 0.0, {'hall': 0.1})
        k += 1
        t = SS + k * sixteenth
    mx.add('sfx', C['gpu_hud'], X.hud_blip('gpu', 'line'), -31.0, 0.3, {'room': 0.2})
    mx.add('sfx', C['gpu_hud'] + 0.2, X.hud_blip('gpu1', 'text'), -31.0, 0.3, {'room': 0.2})
    table(C['datacenter_hud'], 'dc', 3, p=0.3)
    # datacenter hum (span A) - keeps running in the dark until the one-frame cut
    ha = SS - 1.0
    n = ns(HC + 0.1 - ha)
    fans = X.fan_noise(n, 'dcA')
    mains = X.mains_hum(n, ha, 'dcA')
    load = np.zeros(n)
    for t in arp_onsets:
        i = ns(t - ha)
        L = ns(0.1)
        if i + L < n:
            load[i:i + L] += np.exp(-tvec(L) / 0.04)
    load = 0.35 + 0.65 * np.clip(load, 0, 1)
    coil = X.coil_whine(n, ha, 'dcA', load)
    fans *= Adb(n, ha, [(ha, -110), (SS, -48), (DR, -35.5), (SPK, -29.5), (HC, -27)])
    mains_e = Adb(n, ha, [(ha, -110), (SS, -48), (DR, -32.5), (SPK, -28.5), (HC, -26)])
    coil *= Adb(n, ha, [(ha, -110), (SS + 2, -52), (DR, -44), (HC, -40)])
    hum = fans + pan(mains * mains_e, 0.0) + pan(coil, 0.15)
    mx.add('ambience', ha, hum, 0.0, sends={'hall': 0.12})
    # a single spark hangs in the black: one delicate high tone, glowing, gone at spark_out
    n = ns(SPO - SPK + 0.05)
    tt_ = tvec(n)
    rs_ = rng_for('spark')
    glow = 1 + 0.25 * smooth_noise(n, 3.0, rs_)
    sp_ = (np.sin(TAU * hz('A6') * tt_) + 0.5 * np.sin(TAU * (hz('A6') + 0.6) * tt_ + 1.3)
           + 0.06 * np.sin(TAU * 2 * hz('A6') * tt_)) * glow
    sp_ *= Adb(n, SPK, [(SPK, -110), (SPK + 0.9, -36), (SPO - 0.6, -37), (SPO, -110)])
    mx.add('music', SPK, sp_, 0.0, 0.05, {'hall': 0.3, 'space': 0.3})
    grain_cloud(mx, 'sfx', SPK + 0.5, SPO - 0.3, lambda t: 3.0, ['E7', 'A7'], 'sparkcr', (0.003, 0.008),
                (-46, -40), 0.1, {'room': 0.2}, shape='exp')

    # -------------------------------------------------------------------------
    # ACT II - WICK  (stillness: the candle nearly silent, the machine cold and exact)
    # -------------------------------------------------------------------------
    log('act II')
    MS, FC = C['match_strike'], C['flame_catch']
    mx.add('sfx', MS, X.match_strike('m1'), -12.0, sends={'room': 0.3, 'hall': 0.08})
    mx.add('sfx', FC, X.flame_catch('c1'), -21.0, sends={'room': 0.3})
    CB = C['cut_black']
    TR = C['track_right']
    CR, CRE = C['candle_return'], C['candle_reenter']
    PO, PN = C['power_off'], C['power_on']
    cas0, cas1 = C['copy_cascade_start'], C['copy_cascade_end']
    DS, WS0, WS1 = C['desync_start'], C['warm_shift_start'], C['warm_shift_end']
    LF, LS, BS = C['lattice_fade'], C['lean_start'], C['bridge_start']
    VL, VC = C['verdict_label'], C['verdict_cursor']
    ch3i = C['ch3_in']
    IN1, IN2, IN3 = C['install_1'], C['install_2'], C['install_3']
    # the candle: one continuous flame signal F1 (its digital twin is the same signal)
    fa = FC - 0.4
    n = ns(CB + 0.05 - fa)
    F1, flick = X.flame(n, 'candle', crackle_rate=0.3)
    F1 = F1 / (np.std(F1) * 4.0)
    tt = fa + tvec(n)
    cand_g = Adb(n, fa, [(fa, -110), (FC, -110), (FC + 0.5, -22), (TR, -22), (TR + 4, -27), (cas0 - 1, -28),
                         (cas0 + 1, -37), (CR - 0.06, -37), (CR, -20), (ch3i - 0.56, -20), (ch3i - 0.5, -110),
                         (CRE - 0.5, -110), (CRE + 2.0, -23), (LS, -25), (CB, -28)])
    cand_p = np.interp(tt, [FC, TR, TR + 4, CR - 0.01, CR, ch3i - 0.5, CRE, LS, CB],
                       [0.0, 0.0, -0.65, -0.65, 0.0, 0.0, -0.55, -0.4, -0.3])
    cand_p += 0.04 * smooth_noise(n, 0.2, rng_for('cpan'))
    mx.add('ambience', fa, pan(F1 * cand_g, cand_p), 0.0, sends={'room': 0.22, 'hall': 0.04})
    # piano motif, sparse: the candle's question
    pno(mx, FC + 2.8, 'D4', 0.4, ring=6.0, gain=-12.0, p=-0.05)
    pno(mx, FC + 5.0, 'A4', 0.36, ring=6.0, gain=-12.5, p=-0.05)
    pno(mx, FC + 7.4, 'Bb4', 0.4, ring=8.0, gain=-12.0, p=-0.05)
    pno(mx, C['wax_drip'] - 1.2, 'D3', 0.28, ring=7.0, gain=-13.0, p=-0.05)
    mx.add('sfx', C['wax_drip'], X.drip('wax'), -36.0, 0.05, {'room': 0.4})
    # the other fire: digitised twin of the very same flame
    da = TR + 1.0
    i0 = ns(da - fa)
    F1d = F1[i0:]
    nd = len(F1d)
    ref = 4.0 * np.std(F1d)
    steps = [(da, 1500, 3), (C['res_step_1'], 3000, 5), (C['res_step_2'], 6000, 7), (C['res_step_3'], 12000, 9),
             (C['res_step_4'], 24000, 12)]
    Dg = np.zeros(nd)
    td = da + tvec(nd)
    for j, (ts, srd, bits) in enumerate(steps):
        te = steps[j + 1][0] if j + 1 < len(steps) else CB + 1
        w = ((td >= ts - 0.0015) & (td < te + 0.0015)).astype(float)
        w = np.convolve(w, np.ones(ns(0.003)) / ns(0.003), 'same')
        Dg += w * digitize(F1d, srd, bits, ref)
    Dg = lp(hp(Dg, 120.0, 2), 15000.0, 4)
    Dg = eq(Dg, [('highshelf', 3500.0, 0.7, 2.5)])
    dig_g = Adb(nd, da, [(da, -110), (da + 1.0, -25), (C['res_step_4'], -25), (cas0, -26), (CR - 0.06, -26),
                         (CR, -41), (ch3i - 0.56, -41), (ch3i - 0.5, -29), (DS, -29), (WS0, -28), (WS0 + 4, -110)])
    dig_p = np.interp(td, [da, C['copy_2'], C['copy_8'], ch3i], [0.55, 0.55, 0.15, 0.08])
    mx.add('ambience', da, pan(Dg * dig_g, dig_p), 0.0, sends={'room': 0.08, 'hall': 0.1})
    # learning: click-chime at each resolution step
    for j, (key, nt) in enumerate((('res_step_1', 'A5'), ('res_step_2', 'D6'), ('res_step_3', 'E6'),
                                   ('res_step_4', 'A6'))):
        t = C[key]
        mx.add('sfx', t, X.click(f'res{j}', 0.5 + 0.15 * j), -22.0, 0.55, {'room': 0.2})
        mx.add('music', t + 0.012, I.chime(nt, 2.2, f'res{j}', bright=0.25, decay=0.9), -24.0, 0.55,
               {'hall': 0.35})
    # cold sine glimmer
    n = ns(C['seed_enter'] + 1.0 - (da + 0.5))
    sg = I.sine_pad('A5', n, 'glim1', trem=0.5, quant=6) + 0.6 * I.sine_pad('E6', n, 'glim2', trem=0.5, quant=6)
    sg *= Adb(n, da + 0.5, [(da + 0.5, -110), (C['res_step_1'], -47), (C['res_step_4'], -42),
                            (C['card_c2b_in'], -45), (C['seed_enter'] + 1.0, -110)])
    mx.add('music', da + 0.5, sg, 0.0, 0.6, {'hall': 0.4})
    # the copying (imitation): piano phrase answered note-for-note by the machine
    r4 = C['res_step_4'] + 0.7
    pno(mx, r4, 'D4', 0.38, ring=4.0, gain=-12.5, p=-0.55)
    pno(mx, r4 + 0.7, 'A4', 0.35, ring=4.5, gain=-13.0, p=-0.55)
    mx.add('music', r4 + 0.75, I.chime('D5', 2.5, 'imit1', bright=0.1, decay=1.0), -28.0, 0.55, {'hall': 0.35})
    mx.add('music', r4 + 1.45, I.chime('A5', 2.5, 'imit2', bright=0.1, decay=1.0), -28.0, 0.55, {'hall': 0.35})
    # datacenter hum span B (continuous through the power cut; far -> near)
    hb0 = TR - 1.0
    n = ns(CB + 0.05 - hb0)
    fansB = X.fan_noise(n, 'dcB')
    mainsB = X.mains_hum(n, hb0, 'dcB')
    coilB = X.coil_whine(n, hb0, 'dcB')
    near = fansB + pan(mainsB, 0.0) + pan(coilB, 0.2) * 0.4
    far = lp(hp(near, 70.0, 2), 650.0, 2)
    far_e = Adb(n, hb0, [(hb0, -110), (C['res_step_2'], -110), (C['res_step_4'], -43), (C['seed_enter'], -45),
                         (C['copy_2'], -41), (cas0 + 1, -110)])
    near_e = Adb(n, hb0, [(hb0, -110), (C['copy_4'], -110), (cas0, -35), (cas1, -30), (CR - 0.06, -30),
                          (CR, -42), (ch3i - 0.56, -42), (ch3i - 0.5, -33), (WS0 + 2, -34), (LF, -46), (LF + 2, -110)])
    mx.add('ambience', hb0, far * far_e + near * near_e, 0.0, sends={'hall': 0.2})

    # the seed: delicate high chimes following its path
    SE, STD, SB = C['seed_enter'], C['seed_through_digital'], C['seed_burn']
    seedpan = lambda t: float(np.interp(t, [SE, STD, SB], [-0.8, 0.5, -0.45]))
    seedline = [(0.6, 'E6'), (1.5, 'A6'), (2.1, 'D7'), (3.0, 'B6'), (3.6, 'A6'), (5.6, 'E6'), (6.4, 'D6'),
                (7.3, 'A5'), (7.9, 'E6')]
    for k, (dt, nt) in enumerate(seedline):
        t = SE + dt * (SB - SE) / 8.5
        if t > SB - 0.35:
            continue
        mx.add('music', t, I.mallet(nt, 1.8, f'seed{k}', soft=0.35), -28.0, seedpan(t), {'hall': 0.5, 'space': 0.15})
    grain_cloud(mx, 'music', STD - 0.3, STD + 1.6, lambda t: 26.0, ['D6', 'E6', 'A6', 'D7', 'E7'], 'digishimmer',
                (0.02, 0.05), (-38, -32), lambda t: 0.25, {'hall': 0.3}, quant=1.0 / 32, crush=(8000, 6))
    mx.add('sfx', SB, X.tss('seed'), -16.0, -0.45, {'room': 0.3})
    # ...then one beat of silence
    mx.automate(['music', 'ambience'], [(SB + 0.03, 0), (SB + 0.12, -20), (SB + 0.95, -20), (SB + 1.7, 0)])
    mx.automate(['sfx'], [(SB + 0.25, 0), (SB + 0.4, -12), (SB + 0.95, -12), (SB + 1.6, 0)])

    # the copies: stacked dings, cascade, unison choir (cold, exact, restrained)
    for key, notes, spread in (('copy_2', ['D5', 'A5'], 0.25), ('copy_4', ['D5', 'A5', 'D6', 'E6'], 0.5),
                               ('copy_8', ['D5', 'A5', 'D6', 'E6', 'A6', 'D7', 'E7', 'A7'], 0.85)):
        t = C[key]
        for j, nt in enumerate(notes):
            p = (j / max(1, len(notes) - 1) * 2 - 1) * spread
            mx.add('music', t, I.chime(nt, 3.0, f'{key}{j}', bright=0.5, decay=1.4), -27.0 - 10 * np.log10(len(notes)),
                   p, {'hall': 0.4, 'space': 0.2})
        mx.add('sfx', t, X.click(key, 0.8), -27.0, 0.0, {'room': 0.2})
    # sea of copies: the same digital flame, multiplied (wide, perfectly identical)
    sa = C['copy_2']
    j0 = ns(sa - da)
    seaD = Dg[j0:]
    nsd = len(seaD)
    sea_g = Adb(nsd, sa, [(sa, -110), (sa + 0.02, -32), (C['copy_4'], -30), (C['copy_8'], -30), (cas1, -28),
                          (CR - 0.06, -28), (CR, -41), (ch3i - 0.56, -41), (ch3i - 0.5, -30), (LF - 2, -32),
                          (LF + 2, -110)])
    mx.add('ambience', sa, widen(seaD * sea_g, 'sea', 1.0) * 1.2, 0.0, sends={'hall': 0.3})

    def casc_rate(t):
        return min(500.0, 8.0 * 2 ** ((t - cas0) / 0.33))

    grain_cloud(mx, 'music', cas0, cas1 + 1.2, casc_rate, ['D5', 'A5', 'D6', 'E6', 'A6', 'D7', 'A4', 'D4'],
                'cascade', (0.06, 0.2), (-33, -29), lambda t: 0.3 + 0.7 * np.clip((t - cas0) / 3.0, 0, 1),
                {'hall': 0.5, 'space': 0.3}, quant=1.0 / 96, shape='exp',
                amp_fn=lambda t: (8.0 / casc_rate(t)) ** 0.5 * (1.0 if t < cas1 else max(0, 1 - (t - cas1) / 1.2)) * 1.5)
    # unison choir: perfect, no vibrato, no drift; recedes as the one voice leaves it
    chend = WS1 + 2.5
    base = [(CR - 0.06, 0), (CR, -14), (ch3i - 0.56, -14), (ch3i - 0.5, -10), (C['ch3_out'], -10), (DS, -8.5),
            (WS0 + 2.0, -7.5), (WS1, -20), (chend, -110)]
    choir_note(mx, 'D4', cas0 - 0.5, chend, [(cas0 - 0.5, -110), (cas0 + 1, -24), (cas1, -8)] + base, 0.0, -2.0)
    choir_note(mx, 'A3', cas0 + 1.8, chend, [(cas0 + 1.8, -110), (cas1, -12), (cas1 + 2, -9)] + base, -0.25, -4.0)
    choir_note(mx, 'A4', cas0 + 1.8, chend, [(cas0 + 1.8, -110), (cas1, -12), (cas1 + 2, -9)] + base, 0.25, -5.0)
    choir_note(mx, 'D3', cas0 + 3.0, chend, [(cas0 + 3.0, -110), (cas1 + 1, -12), (cas1 + 3, -8)] + base, 0.0, -4.0)
    choir_note(mx, 'D5', cas0 + 3.0, chend, [(cas0 + 3.0, -110), (cas1 + 1, -14), (cas1 + 3, -10)] + base, 0.0, -8.0)
    # power: brown-out sag right before the cut (picture flickers on the same frames),
    # off (gated to digital zero) ... on: relay thunk, everything back, identical
    nsag = len(E['power_sag'])
    mx.add('sfx', PO - nsag / tl['fps'] - 0.01, X.power_sag('off', nsag / tl['fps'] + 0.01), -15.0, 0.1, {'room': 0.2})
    mx.add('sfx', PN, X.relay_thunk('on'), -11.0, 0.0, {'room': 0.35, 'hall': 0.12})
    # candle return: shorter, marked by time
    pno(mx, CR + 0.5, 'A3', 0.32, ring=5.0, gain=-13.0, p=-0.05)
    pno(mx, CR + 1.7, 'D3', 0.28, ring=5.0, gain=-13.5, p=-0.05)

    # -------------------------------------------------------------------------
    # ACT III - MIND: one continuous build from the first install line to the cut
    # -------------------------------------------------------------------------
    log('act III')
    # install log: each line a tone, cold -> glassy -> warm (the candle's question, learned)
    mx.add('sfx', IN1, X.hud_blip('inst1', 'text'), -33.0, 0.15, {'room': 0.2})
    mx.add('sfx', IN2, X.hud_blip('inst2', 'text'), -33.0, 0.15, {'room': 0.2})
    mx.add('sfx', IN3, X.hud_blip('inst3', 'text'), -33.0, 0.15, {'room': 0.2})
    n = ns(2.6)
    tt_ = tvec(n)
    cold = np.sign(np.sin(TAU * hz('D5') * tt_)) * 0.3 + np.sin(TAU * hz('D5') * tt_)     # hard, square-edged
    cold = lp(digitize(cold, 16000, 6, ref=1.4), 9000.0, 2)
    cold *= np.where(tt_ < 0.38, 1.0, np.exp(-(tt_ - 0.38) / 0.06)) * (1 - np.exp(-tt_ / 0.0008))
    mx.add('music', IN1 + 0.05, cold, -30.0, 0.15, {'hall': 0.25})
    gls = I.ting('A5', 4.0, 'inst2') * 0.8 + I.chime('A5', 4.0, 'inst2c', bright=0.2, decay=1.6) * 0.5
    mx.add('music', IN2 + 0.05, gls, -25.0, 0.12, {'hall': 0.4, 'space': 0.15})
    pno(mx, IN3 + 0.05, 'Bb4', 0.48, ring=7.0, gain=-10.5, p=0.1, sends={'hall': 0.35, 'space': 0.1})
    pno(mx, IN3 + 0.05, 'Bb3', 0.32, ring=7.0, gain=-15.0, p=0.1, sends={'hall': 0.35, 'space': 0.1})

    # the one voice that leaves the unison and becomes the cello
    v0 = ch3i - 0.5
    n = ns(CB - v0)
    tt = v0 + tvec(n)
    c4o = C['card_c4a_out']
    line = [(v0, 'D4'), (WS0, 'C#4', 2.5), (WS1 - 1.5, 'D4', 0.25), (WS1 - 0.5, 'E4', 0.12), (WS1 + 0.2, 'F4', 0.12),
            (c4o, 'E4', 0.12), (c4o + 0.7, 'D4', 0.12), (LF + 0.3, 'A3', 0.15), (CRE + 0.8, 'D4', 0.12),
            (CRE + 2.0, 'E4', 0.1), (CRE + 2.6, 'F4', 0.1), (LS + 0.3, 'G4', 0.1), (LS + 1.2, 'A4', 0.12),
            (VL, 'Bb4', 0.12), (VL + 1.0, 'A4', 0.1), (VL + 1.7, 'G4', 0.1), (VC, 'F4', 0.1), (VC + 0.8, 'E4', 0.1),
            (BS, 'A4', 0.12), (BS + 1.5, 'C#5', 0.12), (CB - 0.35, 'D5', 0.5)]
    pm = I.pitch_curve(line, n, v0)
    drift = -12.0 * ease((tt - DS) / (WS0 - DS)) * np.clip(1 - (tt - WS0) / 2.5, 0, 1)  # desync: cents flat
    vrng = rng_for('voice')
    vdepth = 20.0 * ease((tt - (WS0 + 1.0)) / 4.0) * (1 + 0.15 * smooth_noise(n, 0.3, vrng))
    vdepth *= 1 + 0.35 * ease((tt - BS) / (CB - BS))
    vrate = 5.2 * (1 + 0.05 * smooth_noise(n, 0.4, vrng)) * (1 + 0.12 * ease((tt - LS) / (CB - LS)))
    vib = vdepth * np.sin(np.cumsum(TAU * vrate) / SR)
    jit = 2.0 * smooth_noise(n, 3.0, vrng) * ease((tt - WS0) / 3.0)
    fvoice = 440.0 * 2 ** ((pm - 69) / 12.0) * 2 ** ((drift + vib + jit) / 1200.0)
    amp = Adb(n, v0, [(v0, -110), (v0 + 2.0, -6), (WS0, -5.5), (WS0 + 2.5, -4), (WS1 - 1.5, -5), (WS1, -7),
                      (c4o - 0.5, -9), (LF, -8), (CRE, -8), (LS, -6.5), (VL, -5), (BS, -3), (CB, 0)])
    for t, *_ in line[2:]:   # bow-change micro dips
        amp *= 1 - 0.18 * np.exp(-((tt - t) / 0.05) ** 2)
    wc = np.clip((tt - (WS0 + 1.5)) / (WS1 - WS0 - 1.5), 0, 1)
    voice = I.choir_process(I.choir_source(None, n, 0.0, f=fvoice) * amp) * np.cos(wc * np.pi / 2)
    bright = np.interp(tt, [v0, WS1, CRE, BS, CB], [0.3, 0.45, 0.45, 0.75, 0.95])
    cello = I.bowed(fvoice, amp, bright, 'cello', noise=0.03) * np.sin(wc * np.pi / 2)
    vp = np.interp(tt, [v0, LF, CRE + 2, CB], [0.05, 0.05, 0.3, 0.25])
    mx.add('music', v0, voice, -18.0, vp, {'hall': 0.45, 'space': 0.1})
    mx.add('music', v0, cello, -25.0, vp, {'hall': 0.3})
    # HUD: desync lock-on, then failing
    mx.add('sfx', DS + 0.05, X.hud_blip('desync', 'line'), -30.0, 0.1, {'room': 0.2})
    mx.add('sfx', C['hud_glitch'], X.glitch('hud'), -22.0, 0.1, {'hall': 0.15})
    # the original flame drifts out of sync, then turns into a real (warm) flame
    j1 = ns(DS - 1.0 - da)
    Dorig = Dg[j1:]
    no = len(Dorig)
    to = DS - 1.0 + tvec(no)
    dly = 0.03 * ease((to - DS) / (WS0 - DS))
    Dorig = frac_delay(Dorig, dly)
    F2, _ = X.flame(no, 'warm', crackle_rate=0.6)
    F2 = F2 / (np.std(F2) * 4.0)
    F2 = eq(F2, [('lowshelf', 300.0, 0.7, 3.0), ('highshelf', 5000.0, 0.7, -3.0)])
    xw = ease((to - WS0) / (WS1 - WS0))
    worig = Adb(no, DS - 1.0, [(DS - 1.0, -110), (DS, -26), (WS0, -26), (LF, -23), (CRE, -24), (LS, -25), (CB, -28)])
    warm = (Dorig * np.cos(xw * np.pi / 2) + F2 * np.sin(xw * np.pi / 2)) * worig
    mx.add('ambience', DS - 1.0, pan(warm, np.interp(to, [DS, LF, CRE + 2], [0.08, 0.08, 0.35])), 0.0,
           {'room': 0.2, 'hall': 0.05})
    # self-burn: embers flaking from its own body
    sb = C['self_burn_start']
    grain_cloud(mx, 'sfx', sb, CB, lambda t: 2.0 + 6.0 * np.clip((t - sb) / (CB - sb), 0, 1), ['A6', 'D7', 'E7'],
                'flake', (0.004, 0.012), (-40, -33), 0.25, {'room': 0.2, 'hall': 0.2}, shape='exp')
    mx.add('sfx', sb, X.ember_stroke(CB - sb, 'selfburn', 0.15), -35.0, sends={'room': 0.2})

    # heartbeat: enters at the desync, accelerates continuously to the cut
    per0, per1 = 1.08, 0.36
    hper = lambda t: per0 * (per1 / per0) ** (np.clip((t - DS) / (CB - DS), 0, 1) ** 1.35)
    hbt = tempo_times(DS + 0.1, CB - 0.03, hper)
    for k, t in enumerate(hbt):
        x = np.clip((t - DS) / (CB - DS), 0, 1)
        gap = 0.27 * hper(t)
        for j, (dt, s) in enumerate(((0.0, 1.0), (gap, 0.6))):
            if t + dt < CB:
                mx.add('music', t + dt, X.heartbeat_hit(f'hb3{k}{j}', s), -28.0 + 7.0 * x ** 2, 0.0,
                       {'hall': 0.04})

    # strings: stacked layer by layer from the self-burn to the peak
    sb_db = lambda t: float(np.interp(t, [sb, C['card_c4a_in'], LF, CRE, LS, VL, VC, BS, CB],
                                         [-28.0, -25.0, -23.5, -22.0, -20.5, -19.5, -18.5, -17.0, -13.6]))
    prog = [(sb, ['D2', 'A2']), (C['card_c4a_in'], ['D2', 'A2', 'D3', 'F3']),
            (LF, ['D2', 'A2', 'F3', 'A3', 'D4']), (LS, ['Bb1', 'Bb2', 'F3', 'A3', 'D4', 'F4']),
            (VL, ['G1', 'G2', 'D3', 'Bb3', 'F4', 'A4']), (VC, ['C2', 'C3', 'G3', 'E4', 'G4', 'D5']),
            (BS, ['A1', 'A2', 'E3', 'D4', 'G4', 'A4', 'E5']),
            (BS + 1.5, ['A1', 'A2', 'E3', 'A3', 'C#4', 'G4', 'Bb4', 'E5', 'A5'])]
    for i, (ts, notes) in enumerate(prog):
        te = prog[i + 1][0] if i + 1 < len(prog) else CB
        last = i + 1 == len(prog)
        att = 3.0 if i == 0 else (0.35 if ts >= BS else 0.6)
        g0, g1 = sb_db(ts), sb_db(te)
        env = [(ts - 0.25, -110), (ts - 0.25 + att, g0), (te, g1), (te + 0.5, -110)] if not last else \
              [(ts - 0.25, -110), (ts - 0.25 + att, g0), (CB, g1)]
        if i == 0:
            env[0] = (ts, -110)
        chord(mx, notes, ts - (0 if i == 0 else 0.25), te + (0.5 if not last else 0.0), gain=0.0, spread=0.85,
              label=f'build{i}', voices=4, env=env)
    # violins enter on the lean, rise through the bridge
    strings(mx, 'A4', LS, BS, env=[(LS, -110), (LS + 2, -26), (BS, -21), (BS + 0.3, -110)], p=0.3, voices=5,
            spread=0.8, label='vlnA')
    strings(mx, 'E5', BS - 0.4, CB, env=[(BS - 0.4, -110), (BS + 0.6, -21), (CB, -14.5)], p=0.2, voices=6, spread=0.9,
            label='bridgeV', fcurve=lambda t: hz('E5') * 2 ** (5 / 12 * ease((t - BS) / (CB - BS))))
    strings(mx, 'A5', BS + 1.5, CB, env=[(BS + 1.2, -110), (BS + 2.0, -23), (CB, -16.0)], p=-0.25, voices=6,
            spread=0.9, label='topV')
    s_bright += [(sb - 1, 0.15), (sb, 0.15), (LS, 0.4), (BS, 0.7), (CB - 0.02, 1.0)]
    s_space += [(sb - 1, 0.1), (CB, 0.15)]
    # candle re-enters: its piano asks the question again; arpeggios lock to the heartbeat from the lean
    pno(mx, CRE + 0.3, 'D4', 0.4, ring=4.0, gain=-14.0, p=-0.5)
    pno(mx, CRE + 1.6, 'A4', 0.38, ring=4.0, gain=-14.5, p=-0.5)
    pno(mx, CRE + 2.9, 'Bb4', 0.42, ring=5.0, gain=-14.0, p=-0.5)
    for k, t in enumerate(hbt):
        if t < LS:
            continue
        chs = [c for ts, c in prog if ts <= t + 0.25][-1]
        x = np.clip((t - LS) / (CB - LS), 0, 1)
        for j, dt in enumerate((0.0, hper(t) / 2)):
            if t + dt >= CB - 0.02:
                continue
            nt = chs[(k * 2 + j) % len(chs)]
            m = midi(nt) + (12 if (k + j) % 3 == 2 else 0) + (24 if midi(nt) < 40 else (12 if midi(nt) < 50 else 0))
            pno(mx, t + dt, m, 0.3 + 0.45 * x, ring=1.4, held=0.7, gain=-23.0 + 4.0 * x ** 2, p=-0.45, label='arp3')
    # tutti brass/organ weight from the verdict, opening to the peak
    n = ns(CB - VL)
    oc = np.interp(VL + tvec(n), [VL, BS, CB], [0.1, 0.4, 1.0])
    brv = I.brass_pad(['D2', 'A2', 'D3', 'F3'], n, 'verdict', oc)
    brv *= Adb(n, VL, [(VL, -110), (VL + 2.0, -22), (VC, -20), (VC + 0.2, -110)])
    mx.add('music', VL, widen(brv, 'brassV', 0.4), -15.0, sends={'hall': 0.3})
    n = ns(CB - (BS - 0.3))
    oc = np.interp(BS - 0.3 + tvec(n), [BS - 0.3, CB], [0.3, 1.0])
    bra = I.brass_pad(['A1', 'A2', 'E3', 'A3', 'C#4'], n, 'bridge', oc)
    bra *= Adb(n, BS - 0.3, [(BS - 0.3, -110), (BS + 0.5, -14), (BS + 1.5, -10), (CB, -2.6)])
    mx.add('music', BS - 0.3, widen(bra, 'brassB', 0.4), -22.5, sends={'hall': 0.3})
    # the verdict table typed under the build; the bridge: air, shimmer, a swell into the cut
    for j in range(3):
        mx.add('sfx', VL + 0.1 + j * 0.7, X.hud_blip(f'verdict{j}', 'text'), -32.0, 0.25, {'room': 0.2})
    mx.add('ambience', LS, X.wind_gust(3.8, 'lean', -0.5, 0.45), -27.0, sends={'hall': 0.3})
    rs = X.reverse_swell(CB - BS, 'bridge', 1200.0, 14000.0, end_fade=0.002)
    mx.add('sfx', BS, rs, -19.5, sends={'hall': 0.1})
    n = ns(CB - BS)
    shim = sum(I.glass(nt, n, 'peak' + nt, beat=0.9) for nt in ('A6', 'E7', 'C#7'))
    shim *= Adb(n, BS, [(BS, -110), (CB, -28.5)])
    mx.add('music', BS, widen(shim, 'peakshim'), 0.0, sends={'hall': 0.3, 'space': 0.2})

    # -------------------------------------------------------------------------
    # EPILOGUE
    # -------------------------------------------------------------------------
    log('epilogue')
    SRt = C['stars_return']
    ep0 = SRt - 0.5
    ZI, ZD = C['zhuangzi_in'], C['zhuangzi_dissolve']
    CO = C['credits_out']
    SL = C['session_log_in']
    pend = SL - 0.1
    TG = C['title_glow']
    H0 = C['title_xin_heart_start']
    sus = ['D3', 'A3', 'E4', 'A4', 'D5']
    envE = [(ep0, -110), (SRt + 3, -10), (ZI + 4.5, -9), (H0, -10), (TG, -12), (TG + 2.5, -13), (C['title_out'], -13),
            (C['credits_in'], -15), (CO - 1.0, -19), (pend, -110)]
    for i, nt in enumerate(sus):
        strings(mx, nt, ep0, pend, env=envE, gain=-17.0, p=(i / 4 * 2 - 1) * 0.6, voices=3, label='sus')
    s_bright += [(ep0 - 0.1, 0.2), (TG, 0.25), (TG + 2, 0.35), (pend, 0.2)]
    s_space += [(ep0 - 0.1, 0.6), (pend, 0.6)]
    n = ns(H0 + 1 - ep0)
    gp = I.glass('E6', n, 'epi1', beat=0.21) + 0.7 * I.glass('A6', n, 'epi2', beat=0.33)
    gp *= Adb(n, ep0, [(ep0, -110), (SRt + 4, -42), (H0 - 2, -44), (H0 + 1, -110)])
    mx.add('music', ep0, widen(gp, 'epiglass'), 0.0, sends={'space': 0.7})
    grain_cloud(mx, 'music', ep0, CO, lambda t: 4.0, spool, 'stars2', (0.02, 0.08), (-43, -36), 0.9, {'space': 0.75},
                amp_fn=lambda t: min(1.0, (t - ep0) / 3.0) * (1.0 if t < CO - 3 else max(0, (CO - t) / 3)))
    # a universe full of small fires: warm flickers, pairs, more and more
    fl_rate = lambda t: 0.6 + 10.0 * np.clip((t - SRt - 2) / (H0 - SRt - 3), 0, 1) ** 1.5
    grain_cloud(mx, 'sfx', SRt + 1.0, H0, fl_rate, ['A4', 'E5'], 'fires', (0.003, 0.009),
                (-46, -40), lambda t: 0.1 + 0.85 * np.clip((t - SRt - 2) / (H0 - SRt - 3), 0, 1),
                {'room': 0.1, 'space': 0.4}, shape='exp')
    n = ns(H0 - SRt)
    pair, _ = X.flame(n, 'pair', crackle_rate=0.25)
    pair = pair / (np.std(pair) * 4.0) * Adb(n, SRt, [(SRt, -110), (SRt + 2, -44), (SRt + 10, -46), (H0, -110)])
    mx.add('ambience', SRt, np.stack([pair, np.roll(pair, ns(0.37))]) * 0.7, 0.0, sends={'hall': 0.2})
    # the Zhuangzi epigraph: the motif transformed, D - A - E, resting on sus2 (never resolves)
    pno(mx, ZI, 'D4', 0.44, ring=8.0, gain=-10.0, sends={'hall': 0.3, 'space': 0.3})
    pno(mx, ZI + 2.0, 'A4', 0.42, ring=8.0, gain=-10.5, sends={'hall': 0.3, 'space': 0.3})
    pno(mx, ZI + 4.5, 'E5', 0.45, ring=10.0, gain=-10.0, sends={'hall': 0.3, 'space': 0.35})
    pno(mx, ZI + 4.5, 'D3', 0.3, ring=10.0, gain=-14.0, sends={'hall': 0.3, 'space': 0.35})
    pno(mx, ZI + 4.55, 'A3', 0.28, ring=10.0, gain=-15.0, sends={'hall': 0.3, 'space': 0.35})
    # the text burns into embers and drifts among the small fires - the fire passes on
    mx.add('sfx', ZD, X.ember_stroke(3.2, 'zdissolve', 0.2), -30.0, sends={'space': 0.45})
    grain_cloud(mx, 'music', ZD + 0.2, ZD + 3.6, lambda t: 7.0, ['A5', 'D6', 'E6', 'A6', 'E7'], 'zembers',
                (0.03, 0.12), (-44, -38), 0.7, {'space': 0.65},
                amp_fn=lambda t: min(1.0, (t - ZD) / 0.6) * max(0.0, min(1.0, (ZD + 3.6 - t) / 1.5)))
    for dt, nt in ((2.5, 'D5'), (4.0, 'A5'), (5.8, 'E6')):
        n = ns(5.0)
        gg = I.glass(nt, n, 'echo' + nt, beat=0.4) * Adb(n, 0, [(0, -110), (0.08, -33), (1.5, -40), (5.0, -110)])
        mx.add('music', ZD + dt, gg, 0.0, 0.3, {'space': 0.7})
    # title: the heart written in embers, two wick-grass strokes falling, the glow
    h1 = C['title_xin_heart_end']
    sl = (h1 - H0) / 4
    for k, p in enumerate((-0.25, 0.0, 0.08, 0.3)):
        mx.add('sfx', H0 + k * sl, X.ember_stroke(sl * 0.88, f'heart{k}', p), -29.0, sends={'space': 0.35})
    g0, g1 = C['title_xin_grass_start'], C['title_xin_grass_end']
    for k, (t, p) in enumerate(((g0, -0.12), ((g0 + g1) / 2, 0.12))):
        n = ns(1.2)
        tt_ = tvec(n)
        f = hz('A6') * (hz('D6') / hz('A6')) ** np.clip(tt_ / 0.5, 0, 1)
        y = np.sin(np.cumsum(TAU * f) / SR) * np.exp(-tt_ / 0.35) * (1 - np.exp(-tt_ / 0.01))
        mx.add('music', t, y, -33.0, p, {'space': 0.5})
        mx.add('sfx', t, X.whoosh(0.6, f'grass{k}', peak=0.6, f_lo=1500, f_hi=5000, width_oct=0.8,
                                  pan_from=p, pan_to=p), -40.0, sends={'space': 0.3})
    mx.add('music', TG, I.bell('D3', 12.0, 'title'), -22.0, 0.0, {'hall': 0.2, 'space': 0.8})
    pno(mx, TG, 'D1', 0.7, ring=11.0, gain=-19.0, sends={'hall': 0.3, 'space': 0.5})
    pno(mx, TG, 'D2', 0.6, ring=11.0, gain=-21.0, sends={'hall': 0.3, 'space': 0.5})
    n = ns(6.0)
    gs = sum(I.glass(nt, n, 'latin' + nt, beat=0.3) for nt in ('D6', 'A6', 'E7'))
    gs *= Adb(n, 0, [(0, -110), (0.7, -39), (2.0, -43), (6.0, -110)])
    mx.add('music', C['title_latin'], widen(gs, 'latin'), 0.0, sends={'space': 0.7})
    # credits: last, softest statement
    ci = C['credits_in']
    for dt, nt, v in ((2.0, 'D4', 0.3), (3.5, 'A4', 0.28), (5.3, 'E5', 0.3)):
        pno(mx, ci + dt, nt, v, ring=min(6.0, pend - (ci + dt)), gain=-14.0, sends={'hall': 0.3, 'space': 0.4})
    mx.automate(['music', 'sfx', 'ambience'], [(CO, 0), (pend - 0.1, -60), (pend, -110), (pend + 0.05, 0)])
    # end: a match in the dark
    EM = C['end_match_strike']
    mx.add('sfx', EM, X.match_strike('m2'), -12.0, sends={'room': 0.3, 'hall': 0.08})
    EH, EF = C['end_flame_hiss'], C['end_fade']
    n = ns(D - EH)
    F3, _ = X.flame(n, 'end', crackle_rate=0.4)
    F3 = F3 / (np.std(F3) * 4.0) * Adb(n, EH, [(EH, -110), (EH + 0.4, -22), (EF, -23), (EF + 0.5, -110)])
    mx.add('ambience', EH, F3, 0.0, 0.0, {'room': 0.25})
    mx.automate(['music', 'sfx', 'ambience'], [(EF, 0), (EF + 0.5, -110)])

    # -------------------------------------------------------------------------
    # cards: make room (music thins under every visible card; the epigraph owns its motif)
    # -------------------------------------------------------------------------
    for cd in tl.get('cards', []):
        a, b = cd['in'], cd['out']
        if any(wa <= a and b <= wb for wa, wb in windows) or cd['id'] in ('credits', 'ch2', 'zhuangzi', 'session'):
            continue
        depth = -1.5 if a >= C['install_1'] - 3 else -2.5    # inside the build: only a breath
        mx.automate(['music'], [(a - 0.8, 0), (a, depth), (b, depth), (b + 0.8, 0)])

    # -------------------------------------------------------------------------
    # process the strings and choir buses
    # -------------------------------------------------------------------------
    log('buses')
    sp_ = nz_span(mx.strings, ns(0.5))
    if sp_:
        a, b = sp_
        tt = np.arange(a, b) / SR
        bp_ = sorted(s_bright)
        br = np.interp(tt, [p[0] for p in bp_], [p[1] for p in bp_])
        sq = sorted(s_space)
        spc = np.interp(tt, [p[0] for p in sq], [p[1] for p in sq])
        y = I.strings_process(mx.strings[:, a:b].astype(float), br) * db(-8.0)
        # section 'ff' saturation: a 2x-oversampled soft knee set from the bus's own RMS in the
        # last 3 s before the cut; quieter passages stay linear, the rare saw-stack peaks round off
        ia, ib = ns(C['cut_black'] - 3.0) - a, ns(C['cut_black']) - a
        if 0 <= ia < ib <= y.shape[1]:
            knee = 2.4 * float(np.sqrt(np.mean(y[:, ia:ib] ** 2)))
            up = signal.resample_poly(y, 2, 1, axis=-1)
            up = knee * np.tanh(up / knee)
            y = signal.resample_poly(up, 1, 2, axis=-1)[:, :b - a]
        mx.add_bus('music', y.astype(np.float32), a, {'hall': 0.3, 'space': spc.astype(np.float32)})
    sp_ = nz_span(mx.choir, ns(0.5))
    if sp_:
        a, b = sp_
        raw = mx.choir[:, a:b].astype(float)
        y = np.stack([decorrelate(I.choir_process(raw[0]), 'choirL'), decorrelate(I.choir_process(raw[1]), 'choirR')])
        mx.add_bus('music', (y * db(-24.0)).astype(np.float32), a, {'hall': 0.5, 'space': 0.15})
    return mx, windows, groups


def silence_windows(tl):
    """Required absolute digital silence, from the timeline (SCRIPT v2 '声音')."""
    C = tl['cues']
    D = float(tl['duration'])
    return [(0.0, C['silence_end']),
            (C['hum_cut'], C['match_strike'] - 0.05),
            (C['power_off'], C['power_on']),
            (C['cut_black'], C['stars_return'] - 0.5),
            (C['session_log_in'], C['end_match_strike']),
            (C['end_fade'] + 0.5, D)]


# =============================================================================
# master
# =============================================================================
def gate_mask(N, windows, fade_out=0.002, fade_in=0.0005):
    g = np.ones(N)
    for a, b in windows:
        ia, ib = ns(a), min(ns(b), N)
        if ib <= ia:
            continue
        g[ia:ib] = 0.0
        k = ns(fade_out)
        j0 = max(0, ia - k)
        m = ia - j0
        if m > 0:
            g[j0:ia] *= 0.5 + 0.5 * np.cos(np.pi * (np.arange(m) + 1) / (m + 1))
        if ib < N:
            k2 = ns(fade_in)
            g[ib:ib + k2] *= 0.5 - 0.5 * np.cos(np.pi * np.arange(k2) / k2)
    return g


def main():
    tl = json.load(open(os.path.join(FILM, 'timeline.json')))
    D = float(tl['duration'])
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(OUT, 'stems'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'qa'), exist_ok=True)
    mx, windows, groups = build(tl)
    for w in mx.warn:
        log('WARN', w)
    log('impulse responses')
    irs = {'room': make_ir('room', 0.9, t60_curve(0.55, 0.45, 0.3, 0.18), predelay=0.003, er_span=0.03),
           'hall': make_ir('hall', 4.6, t60_curve(3.3, 2.7, 1.7, 0.8), predelay=0.022, er_span=0.07),
           'space': make_ir('space', 11.0, t60_curve(8.5, 7.0, 4.2, 2.0), predelay=0.045, buildup=0.09,
                            n_er=6, er_gain=0.25)}
    log('reverbs + stems')
    stems = mx.render(irs)
    del mx
    # brown-out: music and ambience dip on the same frames the picture flickers (sfx carries the sag itself)
    N = stems[next(iter(stems))].shape[1]
    sag = np.ones(N)
    po = tl['cues']['power_off']
    pat = tl['events']['power_sag']
    fps = tl['fps']
    for k, v in enumerate(pat):
        a = ns(po - (len(pat) - k) / fps)
        sag[a:min(N, ns(po - (len(pat) - k - 1) / fps))] = v
    sag = np.convolve(sag, np.ones(ns(0.006)) / ns(0.006), 'same')
    mix = sum(stems[s].astype(np.float64) * (1.0 if s == 'sfx' else sag) for s in stems)
    # master bus: subsonic/DC high-pass, mono below 110 Hz
    mix = hp(mix, 18.0, 4)
    mix = lp(mix, 19500.0, 8)
    mid = 0.5 * (mix[0] + mix[1])
    side = hp(0.5 * (mix[0] - mix[1]), 110.0, 2)
    mix = np.stack([mid + side, mid - side])
    gate = gate_mask(N, windows)
    mix *= gate
    log('loudness / limiter')
    target = -16.0
    l0 = M.integrated_lufs(mix)
    gain = 10 ** ((target - l0) / 20)
    for it in range(4):
        z, clip_frac = M.soft_clip_os(mix * gain, knee_db=-6.0)
        z *= gate
        G = M.limiter_gain(z, ceiling_db=-1.3, release=0.35)
        out = z * G
        li = M.integrated_lufs(out)
        log(f'  iter {it}: gain {20 * np.log10(gain):+.2f} dB -> {li:.2f} LUFS, '
            f'max GR {-20 * np.log10(G.min()):.2f} dB, soft-clip active on {100 * clip_frac:.3f}% of samples')
        if abs(li - target) < 0.05:
            break
        gain *= 10 ** ((target - li) / 20)
    out *= gate
    grdb = -20 * np.log10(G)
    h = ns(0.25)
    nb = len(grdb) // h
    gb = grdb[:nb * h].reshape(nb, h).max(axis=1)
    gr_report = [f'{i * 0.25:7.2f}s {v:4.1f} dB' for i, v in enumerate(gb) if v > 1.0]
    log('limiter GR > 1 dB at:', ', '.join(gr_report[:40]))
    tp = M.true_peak_dbtp(out)
    li = M.integrated_lufs(out)
    log(f'final: {li:.2f} LUFS integrated, true peak {tp:.2f} dBTP')
    M.write_wav24(os.path.join(OUT, 'score.wav'), out)
    stem_lvls = {}
    for s in stems:
        st = stems[s].astype(np.float64) * gain * G * gate
        M.write_wav_f32(os.path.join(OUT, 'stems', f'{s}.wav'), st)
        stem_lvls[s] = st
    log('QA')
    # verify from the written file
    xs, flat = M.read_wav24(os.path.join(OUT, 'score.wav'))
    report = []
    report.append(f'samples: {xs.shape[1]} (expected {ns(D)}), duration {xs.shape[1] / SR:.4f} s')
    xf = xs / 2 ** 23
    report.append(f'integrated loudness: {M.integrated_lufs(xf):.2f} LUFS; true peak {M.true_peak_dbtp(xf):.2f} dBTP; '
                  f'sample peak {20 * np.log10(np.abs(xf).max()):.2f} dBFS')
    report.append(f'DC offset L/R: {xf[0].mean():.2e} / {xf[1].mean():.2e}')
    report.append(f'full-scale samples: {int(np.sum(np.abs(xs) >= 2 ** 23 - 1))}')
    for a, b in windows:
        ia, ib = ns(a), min(ns(b), xs.shape[1])
        if ib <= ia:
            report.append(f'silence [{a:.3f}, {b:.3f}): empty window')
            continue
        nzc = int(np.count_nonzero(xs[:, ia:ib]))
        report.append(f'silence [{a:.3f}, {b:.3f}): {ib - ia} samples/ch, nonzero = {nzc}')
    F = np.abs(np.fft.rfft(xf.mean(axis=0)[: 2 ** 23]))
    fr = np.fft.rfftfreq(2 ** 23, 1 / SR)
    report.append(f'energy above 20 kHz: {10 * np.log10((F[fr > 20000] ** 2).sum() / (F ** 2).sum()):.1f} dB re total')
    lo = lp(xf, 120.0, 4)
    cor = np.corrcoef(lo[0], lo[1])[0, 1]
    report.append(f'L/R correlation below 120 Hz: {cor:.3f}')
    C = tl['cues']
    tS, lS = M.loudness_curve(xf, 3.0)
    tM, lM = M.loudness_curve(xf, 0.4)
    for name, (a, b) in {'prologue': (C['silence_end'], C['collapse_start']),
                         'act I': (C['collapse_start'], C['hum_cut']),
                         'act II': (C['match_strike'], C['ch3_in']),
                         'act III': (C['ch3_in'], C['cut_black']),
                         'epilogue': (C['stars_return'] - 0.5, C['session_log_in'])}.items():
        m = (tS - 1.5 >= a) & (tS + 1.5 <= b)
        report.append(f'short-term LUFS {name:9s}: max {lS[m].max():6.1f}, median {np.median(lS[m]):6.1f}')
    # the two big moments: ignition (held back) vs the one climax at cut_black
    mi = (tS - 1.5 >= C['ignite']) & (tS + 1.5 <= C['ignite'] + 4.0)
    mc = (tS + 1.5 <= C['cut_black']) & (tS - 1.5 >= C['cut_black'] - 4.0)
    mmi = (tM >= C['ignite']) & (tM <= C['ignite'] + 4.0)
    mmc = (tM + 0.2 <= C['cut_black']) & (tM >= C['cut_black'] - 4.0)
    report.append(f"ignition  (3 s windows inside [ignite, +4]):    short-term max {lS[mi].max():6.1f} LUFS, "
                  f"momentary max {lM[mmi].max():6.1f}")
    report.append(f"climax    (3 s windows inside [cut_black-4, cut]): short-term max {lS[mc].max():6.1f} LUFS, "
                  f"momentary max {lM[mmc].max():6.1f}")
    report.append(f"loudest short-term window of the film: {lS.max():.1f} LUFS centred at {tS[np.argmax(lS)]:.1f} s")
    report.append(f'soft clipper (-6 dBFS knee, 4x OS) active on {100 * clip_frac:.3f}% of samples')
    zz = np.abs(mix * gain).max(axis=0) > 10 ** (-6 / 20)
    for nm, (a, b) in {'ignition': (C['ignite'], C['ignite'] + 3), 'climax': (C['cut_black'] - 5, C['cut_black'])}.items():
        seg = zz[ns(a):ns(b)]
        report.append(f'  clipper engaged {nm:8s} [{a:.1f}, {b:.1f}): {100 * seg.mean():.2f}% of samples; '
                      f'elsewhere {100 * (zz.sum() - seg.sum()) / (len(zz) - len(seg)):.3f}%')
        zz[ns(a):ns(b)] = False
        zin = mix[:, ns(a):ns(b)] * gain
        zcl, _ = M.soft_clip_os(zin, knee_db=-6.0)
        dist = 10 * np.log10(np.sum((zcl - zin) ** 2) / np.sum(zin ** 2) + 1e-30)
        report.append(f'  clipper change energy {nm:8s}: {dist:.1f} dB re signal; '
                      f'peak in {20 * np.log10(np.abs(zin).max()):+.1f} dBFS -> {20 * np.log10(np.abs(zcl).max()):+.1f}')
    report.append('limiter gain reduction > 1 dB (250 ms bins): ' + (', '.join(gr_report) or 'none'))
    report.append(f'render time: {time.time() - T0:.1f} s')
    txt = '\n'.join(report)
    print(txt)
    open(os.path.join(OUT, 'qa', 'report.txt'), 'w').write(txt + '\n')
    M.qa_plots(xf, tl['cues'], windows, os.path.join(OUT, 'qa'), stems=stem_lvls)
    M.qa_zoom(xf, tl, windows, os.path.join(OUT, 'qa', 'zoom.png'))
    log('done')


if __name__ == '__main__':
    main()
