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
    shots = {s['name']: s for s in tl['shots']}
    windows = [(0.0, C['silence_end']),
               (C['hum_cut'], C['match_strike'] - 0.05),
               (C['power_off'], C['power_on']),
               (C['cut_black'], C['stars_return'] - 0.5),
               (C['credits_out'] + 1.5, C['end_match_strike']),
               (C['end_fade'] + 0.5, D)]
    groups = [(C['silence_end'], C['hum_cut']),
              (C['match_strike'] - 0.05, C['cut_black']),
              (C['stars_return'] - 0.5, C['credits_out'] + 1.5),
              (C['end_match_strike'], min(D, C['end_fade'] + 0.5))]
    mx = Mixer(D, groups)
    # automation of the strings bus (brightness and sends), absolute time
    s_bright, s_space = [(0.0, 0.25)], [(0.0, 0.45)]

    # -------------------------------------------------------------------------
    # PROLOGUE
    # -------------------------------------------------------------------------
    log('prologue')
    t_on = C['silence_end']
    LAND = shots['epigraph']['start']           # the riser lands here (20.0)
    REL = C['astra_release']
    COL = C['collapse_start']
    ign = E.get('astra_star_ignitions', [C['first_star']])
    ticks = E.get('astra_line_ticks', list(np.linspace(C['astra_lines_start'], C['astra_lines_end'], 14)))

    # sub drone D1, from below threshold
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
                           (C['astra_hold_start'], -33), (REL, -29), (LAND - 0.05, -15), (LAND + 0.6, -19),
                           (C['epigraph_dissolve'], -24), (COL, -22), (COL + 2.0, -30), (t1, -110)])
    mx.add('music', t_on, drone, 0.0, 0.0, {'space': 0.08})
    # one thread of high glass
    n = ns(LAND + 1.5 - 1.5)
    g = I.glass('D7', n, 'pro1', beat=0.31) + 0.35 * I.glass('A7', n, 'pro2', beat=0.17)
    g *= Adb(n, 1.5, [(1.5, -110), (C['first_star'], -47), (C['astra_hold_start'], -42), (REL, -44),
                      (LAND - 1, -52), (LAND + 1.5, -110)])
    mx.add('music', 1.5, g, 0.0, np.sin(TAU * 0.03 * tvec(n)) * 0.25, {'space': 0.7})

    # first star 'ting' + anamorphic air streak
    t = ign[0]
    mx.add('music', t, I.ting('A6', 6.0, 'first'), -21.0, -0.35, {'space': 0.55})
    air = X.whoosh(1.8, 'flare1', peak=0.12, f_lo=3500, f_hi=9000, width_oct=0.8, pan_from=-0.5, pan_to=0.3)
    mx.add('sfx', t, air, -40.0, sends={'space': 0.4})
    # hero stars of the constellation: delicate pings inside the shimmer
    pool = ['E6', 'A6', 'D7', 'B6', 'E7', 'G6', 'A7', 'C7', 'D7', 'E6', 'A6', 'G7']
    prng = rng_for('heropan')
    for k, t in enumerate(ign[1:]):
        f = hz(pool[k % len(pool)])
        mx.add('music', t, X.star_ping(f, f'hero{k}'), -28.0 - 0.15 * k, prng.uniform(-0.7, 0.7),
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

    grain_cloud(mx, 'music', a0 - 0.6, LAND + 0.5, srate, spool, 'stars', (0.02, 0.09), (-49, -41), 0.9,
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
    # release: stars stream past, reverse swell + riser into the landing
    mx.add('sfx', REL, X.reverse_swell(LAND - REL, 'rel'), -17.0, sends={'space': 0.12})
    mx.add('music', REL, X.riser_tone(LAND - REL, 'rel', hz('A4'), hz('D6')), -27.0, sends={'space': 0.4})
    passes = [(REL + 0.35, 1.0, -1), (REL + 0.9, 0.85, 1), (REL + 1.35, 0.7, -1), (REL + 1.72, 0.6, 1),
              (REL + 2.02, 0.55, -1), (REL + 2.3, 0.6, 1)]
    for k, (t, d, side) in enumerate(passes):
        w = X.whoosh(d, f'pass{k}', peak=0.45, f_lo=700, f_hi=5500, width_oct=0.9,
                     pan_from=0.15 * side, pan_to=0.95 * side)
        mx.add('sfx', t, w, -30.0 + 1.2 * k, sends={'space': 0.25})
    mx.add('sfx', REL + 0.9, X.whoosh(2.4, 'flythru', peak=0.58, f_lo=160, f_hi=2600, width_oct=1.4,
                                      pan_from=-0.2, pan_to=0.2), -21.0, sends={'space': 0.3})

    # epigraph: first statement of the motif D - A - Bb, bowed fifth beneath
    pno(mx, LAND, 'D2', 0.55, ring=9.0, gain=-7.0, sends={'hall': 0.25, 'space': 0.35})
    pno(mx, LAND, 'D3', 0.5, ring=7.0, gain=-9.0, sends={'hall': 0.25, 'space': 0.35})
    pno(mx, LAND + 2.0, 'A3', 0.46, ring=6.5, gain=-8.0, sends={'hall': 0.25, 'space': 0.35})
    pno(mx, LAND + 4.3, 'Bb3', 0.5, ring=8.0, gain=-7.5, sends={'hall': 0.25, 'space': 0.4})
    for nt, p in (('D2', -0.15), ('A2', 0.15), ('D3', 0.0)):
        strings(mx, nt, LAND, COL - 0.3, att=2.5, rel=2.0, gain=-27.0, p=p, label='epi')
    s_bright += [(LAND, 0.2), (COL - 0.5, 0.2)]
    # embers rising as the text dissolves
    ed = C['epigraph_dissolve']
    mx.add('sfx', ed, X.ember_stroke(COL - ed + 0.5, 'dissolve', 0.15), -31.0, sends={'space': 0.45})
    grain_cloud(mx, 'music', ed, COL + 0.5, lambda t: 6.0, ['A5', 'D6', 'E6', 'A6'], 'embers',
                (0.03, 0.12), (-44, -37), 0.6, {'space': 0.6})

    # -------------------------------------------------------------------------
    # ACT I - HEAT (one take)
    # -------------------------------------------------------------------------
    log('act I')
    IMP, IGN = C['implode'], C['ignite']
    ost0 = C['ch1_in'] + 0.5
    # ostinato: accelerating 8ths (Kepler spin-up)
    p0, p1 = 0.42, 0.19
    per = lambda t: p0 * (p1 / p0) ** (np.clip((t - ost0) / (IMP - ost0), 0, 1) ** 1.3)
    otimes = tempo_times(ost0, IMP - 0.12, per)
    patt = ['D2', 'D2', 'A2', 'D2', 'D2', 'D2', 'Bb2', 'A2']
    for k, t in enumerate(otimes):
        nt = patt[k % 8]
        x = np.clip((t - ost0) / (IMP - ost0), 0, 1)
        d = 0.24
        nn = ns(d + 0.15)
        tt_ = tvec(nn)
        acc = 1.0 if k % 4 == 0 else 0.72
        amp = (1 - np.exp(-tt_ / 0.006)) * np.exp(-tt_ / (0.07 + 0.05 * (1 - x))) * acc
        f = np.full(nn, hz(nt)) * 2 ** (rng_for(f'o{k}').normal(0, 3) / 1200)
        y = I.bowed(f, amp, np.full(nn, 0.25 + 0.45 * x), f'ost{k}', noise=0.05)
        y += 0.5 * np.sin(TAU * hz(nt) / 2 * tt_) * amp * (0.4 + 0.6 * x)
        gdb = -30.0 + 16.0 * x ** 0.8
        mx.add('music', t, y, gdb, 0.0, {'hall': 0.25})
        if t > ost0 + 6.0:   # octave layer joins, panned pair
            y2 = I.bowed(f * 2, amp, np.full(nn, 0.35 + 0.4 * x), f'osu{k}', noise=0.06)
            mx.add('music', t, y2, gdb - 7.0, 0.3 if k % 2 else -0.3, {'hall': 0.3})
    # rumble swirling faster as the disk spins
    n = ns(IMP + 0.1 - COL)
    rum = X.rumble(n, 'collapse', lambda t: 55.0 * (500.0 / 55.0) ** np.clip(t / (IMP - COL), 0, 1) ** 1.5,
                   lambda t: 0.08 + 1.3 * (t / (IMP - COL)) ** 2)
    rum *= Adb(n, COL, [(COL, -110), (C['ch1_out'], -40), (COL + 10, -28), (IMP - 0.05, -15), (IMP + 0.1, -110)])
    mx.add('ambience', COL, rum, 0.0, sends={'hall': 0.15})
    # low string pad crescendo, heat brightening (dark red -> white)
    pend = IMP + 0.3
    envL = [(COL + 0.5, -110), (COL + 4.0, -30), (IMP - 0.4, -12), (IMP + 0.3, -110)]
    strings(mx, 'D2', COL + 0.5, pend, env=envL, gain=-16.0, p=-0.1, label='colD')
    strings(mx, 'A2', COL + 0.5, pend, env=envL, gain=-18.0, p=0.1, label='colA')
    strings(mx, 'D3', COL + 7.0, pend, env=[(COL + 7.0, -110), (COL + 10, -26), (IMP - 0.4, -12), (IMP + 0.3, -110)],
            gain=-19.0, p=-0.3, label='colD3')
    strings(mx, 'Bb2', COL + 9.5, pend, env=[(COL + 9.5, -110), (COL + 12, -28), (IMP - 0.4, -14), (IMP + 0.3, -110)],
            gain=-20.0, p=0.3, label='colBb')
    # tension: high strings glissando upward (accelerating)
    r0 = COL + 6.0
    gl = lambda f0, f1: (lambda t: f0 * (f1 / f0) ** (np.clip((t - r0) / (IMP - r0), 0, 1) ** 1.7))
    envR = [(r0, -110), (r0 + 2, -30), (IMP - 0.3, -10), (IMP + 0.3, -110)]
    strings(mx, 'A4', r0, pend, env=envR, gain=-21.0, p=0.35, label='rise1', fcurve=gl(hz('A4'), hz('D6')), voices=4)
    strings(mx, 'D4', r0, pend, env=envR, gain=-23.0, p=-0.35, label='rise2', fcurve=gl(hz('D4'), hz('G5')), voices=4)
    s_bright += [(COL, 0.08), (IMP, 0.85)]
    s_space += [(COL - 0.5, 0.45), (COL + 2, 0.15), (IMP, 0.15)]

    # IMPLOSION: suck-out, then vacuum
    mx.add('sfx', IMP, X.suck_out(0.36, 'imp'), -12.0, sends={'room': 0.05})
    mx.automate(['music', 'ambience'], [(IMP, 0), (IMP + 0.08, -6), (IMP + 0.33, -75), (IGN - 0.002, -75), (IGN, 0)])
    mx.automate(['sfx'], [(IMP + 0.34, 0), (IMP + 0.38, -60), (IGN - 0.002, -60), (IGN, 0)])

    # IGNITION: the one Hollywood moment
    mx.add('sfx', IGN, X.sub_drop(7.5, 'ign'), -19.0)
    mx.add('sfx', IGN, X.boom(1.6, 'ign'), -15.0, sends={'hall': 0.15})
    mx.add('sfx', IGN, X.impact_burst(5.0, 'ign'), -13.5, sends={'space': 0.7, 'hall': 0.2})
    mx.add('sfx', IGN + 0.05, X.whoosh(2.4, 'shock', peak=0.22, f_lo=300, f_hi=6500, width_oct=1.3,
                                       pan_from=-0.9, pan_to=0.9, attack_pow=0.7), -16.0, sends={'space': 0.4})
    full = ['D2', 'A2', 'D3', 'F3', 'A3', 'E4', 'A4', 'D5', 'E5', 'A5']
    sp = [(IGN, -110), (IGN + 0.06, -3.5), (IGN + 1.0, -7), (IGN + 2.5, -10), (IGN + 5.0, -9), (C['star_hud_2'] - 0.3, -10),
          (C['star_hud_2'] + 1.5, -110)]
    chord(mx, full, IGN, C['star_hud_2'] + 1.5, gain=-3.0, env=sp, label='ign')
    n = ns(12.0)
    oc = np.interp(tvec(n), [0, 0.1, 3, 12], [0.2, 1.0, 0.35, 0.15])
    br = I.brass_pad(['D2', 'A2', 'D3', 'F3', 'A3'], n, 'ign', oc)
    br *= Adb(n, IGN, [(IGN, -110), (IGN + 0.05, 0), (IGN + 3, -10), (IGN + 9, -13), (IGN + 12, -110)])
    mx.add('music', IGN, widen(br, 'brass', 0.5), -15.0, sends={'hall': 0.3, 'space': 0.35})
    n = ns(9.0)
    gl_ = I.glass('A6', n, 'ign1', beat=0.5) + I.glass('D7', n, 'ign2', beat=0.35)
    gl_ *= Adb(n, IGN, [(IGN, -110), (IGN + 0.03, -30), (IGN + 3, -38), (IGN + 9, -110)])
    mx.add('music', IGN, widen(gl_, 'ignglass'), 0.0, sends={'space': 0.8})
    s_bright += [(IGN - 0.01, 0.85), (IGN, 1.0), (IGN + 3, 0.65), (C['pullback_start'], 0.55)]
    s_space += [(IGN - 0.01, 0.15), (IGN, 0.55), (C['pullback_start'], 0.4)]

    # the star: plasma roar + broad string pad
    PB = C['pullback_start']
    n = ns(PB + 1.5 - (IGN + 0.1))
    pl = X.plasma(n, 'star')
    pl *= Adb(n, IGN + 0.1, [(IGN + 0.1, -110), (IGN + 1.5, -26), (PB - 1, -27), (PB + 1.5, -110)])
    mx.add('ambience', IGN + 0.1, pl, 0.0, sends={'hall': 0.12})
    bb = ['Bb1', 'F2', 'Bb2', 'D3', 'A3', 'C4', 'F4', 'A4', 'D5']
    t = C['star_hud_2']
    chord(mx, bb, t - 0.3, PB + 0.8, att=2.2, rel=1.8, gain=-13.0, label='bb')
    chord(mx, ['C2', 'G2', 'C3', 'G3', 'D4', 'G4', 'C5'], PB, C['earth_arrive'] + 0.3, att=1.5, rel=1.2, gain=-13.0,
          label='csus')
    for t, kind in ((C['star_hud_1'], 'line'), (C['star_hud_1'] + 0.25, 'text'), (C['star_hud_2'], 'text')):
        mx.add('sfx', t, X.hud_blip(f'hud{t}', kind), -31.0, -0.35, {'room': 0.2})

    # pull-back: the film's only fast move
    mx.add('sfx', PB - 0.3, X.whoosh(4.4, 'pullback', peak=0.35, f_lo=140, f_hi=2600, width_oct=1.4,
                                     pan_from=-0.35, pan_to=0.35, attack_pow=1.3), -14.0, sends={'hall': 0.3})
    EA, SU, CD, BF = C['earth_arrive'], C['sunrise'], C['city_dive'], C['brain_form']
    n = ns(BF - PB)
    ab = X.air_bed(n, 'earth')
    ab *= Adb(n, PB, [(PB, -110), (PB + 2, -38), (EA, -31), (CD, -33), (BF, -110)])
    mx.add('ambience', PB, ab, 0.0, sends={'hall': 0.3})
    # modulation to the Dorian IV: G/D, the living B natural
    chord(mx, ['D2', 'G2', 'D3', 'B3', 'D4', 'A4', 'B4', 'G5'], EA, CD + 0.6, att=1.2, rel=1.6, gain=-14.0,
          label='earth')
    s_bright += [(EA, 0.6), (CD, 0.45), (BF, 0.3)]
    s_space += [(EA, 0.4), (CD, 0.2)]
    n = ns(6.0)
    for nt, p, dl in (('B5', -0.4, 0.0), ('D6', 0.4, 0.12), ('A6', -0.1, 0.25), ('E7', 0.2, 0.4)):
        gg = I.glass(nt, n, 'sun' + nt, beat=0.6)
        gg *= Adb(n, 0, [(0, -110), (0.25, -34), (2.0, -40), (6.0, -110)])
        mx.add('music', SU + dl, gg, 0.0, p, {'space': 0.6})
    mx.add('sfx', SU, X.whoosh(2.0, 'sunflare', peak=0.25, f_lo=3000, f_hi=10000, width_oct=0.8,
                               pan_from=-0.6, pan_to=0.6), -36.0, sends={'space': 0.4})
    mx.add('sfx', CD - 0.4, X.whoosh(2.6, 'dive', peak=0.7, f_lo=250, f_hi=3000, width_oct=1.2,
                                     pan_from=0.25, pan_to=-0.2), -17.0, sends={'hall': 0.25})

    # the brain: neural crackle, heartbeat, delicate glass pulses
    SS = C['silicon_snap']
    n = ns(SS - BF)
    ncr = X.neural_crackle(n, 'brain', rate=22.0)
    ncr *= Adb(n, BF, [(BF, -110), (BF + 1.0, -27), (SS - 0.5, -25), (SS, -110)])
    mx.add('ambience', BF, ncr, 0.0, sends={'hall': 0.25})
    hb_per = 60.0 / 62.0
    hbt = tempo_times(BF + 0.4, SS - 0.3, lambda t: hb_per)
    for k, (t, y) in enumerate(X.heartbeat(hbt, 'brain')):
        mx.add('music', t, y, -15.0 + min(0, (t - BF - 2) * 2), 0.0, {'hall': 0.05})
    mpool = ['A5', 'E5', 'F5', 'D5', 'C6', 'A5', 'E5', 'G5']
    for k, t in enumerate(hbt):
        for j, dt in enumerate((0.0, hb_per / 2)):
            nt = mpool[(2 * k + j) % len(mpool)]
            mx.add('music', t + dt + 0.12, I.mallet(nt, 1.6, f'm{k}{j}', soft=0.6), -26.0 - 3 * j,
                   0.4 if (k + j) % 2 else -0.4, {'hall': 0.5})
    chord(mx, ['D4', 'F4', 'A4', 'E5'], BF - 0.5, SS - 0.05, att=2.0, rel=0.25, gain=-21.0, spread=0.7, label='brain')
    mx.add('sfx', C['brain_hud'], X.hud_blip('brainhud', 'text'), -31.0, -0.3, {'room': 0.2})

    # silicon: snap to the grid -> computation arpeggio, machine hum rising
    mx.add('sfx', SS, X.snap('snap'), -11.0, sends={'hall': 0.25, 'room': 0.2})
    s_bright += [(SS - 0.1, 0.3)]
    sixteenth = 60.0 / 120.0 / 4
    bars = [['D4', 'F4', 'A4', 'C5', 'E5'], ['Bb3', 'D4', 'F4', 'A4', 'E5'], ['C4', 'E4', 'G4', 'A4', 'D5'],
            ['D4', 'F4', 'A4', 'C5', 'E5'], ['Bb3', 'D4', 'F4', 'A4', 'C5'], ['C4', 'E4', 'G4', 'D5', 'E5'],
            ['D4', 'F4', 'A4', 'C5', 'E5'], ['D4', 'F4', 'A4', 'C5', 'E5']]
    roots = ['D2', 'Bb1', 'C2', 'D2', 'Bb1', 'C2', 'D2', 'D2']
    patt = [0, 2, 4, 5, 7, 5, 4, 2, 1, 3, 5, 6, 8, 6, 5, 3]
    AF = C['act1_fade']
    c1i, c1o = C['card_c1_in'], C['card_c1_out']
    arp_onsets = []
    k = 0
    t = SS
    while t < AF - 0.05:
        bar = int((t - SS) / (16 * sixteenth))
        tones = bars[min(bar, len(bars) - 1)]
        ext = [midi(x) for x in tones] + [midi(x) + 12 for x in tones]
        idx = patt[k % 16]
        x = np.clip((t - SS) / (c1i - SS), 0, 1)
        in_card = c1i - 0.3 <= t
        if in_card and idx >= 5:
            idx -= 5
        m = ext[idx]
        bright = 0.15 + 0.75 * x if not in_card else 0.35
        acc = 1.0 if k % 4 == 0 else 0.75
        g = -23.0 + 6.0 * x
        if in_card:
            g = -27.0 - 9.0 * np.clip((t - (c1o - 2.0)) / (AF - (c1o - 2.0)), 0, 1) ** 1.5
        y = I.pluck(m, 0.6, bright, f'arp{k}')
        mx.add('music', t, y * acc, g, 0.32 if k % 2 else -0.32, {'hall': 0.3})
        if C['datacenter_reveal'] <= t < c1i - 0.3 and k % 2 == 0:
            y2 = I.pluck(m + 12, 0.35, 0.5, f'arq{k}')
            mx.add('music', t, y2, g - 9.0, -0.6 if k % 4 else 0.6, {'hall': 0.4})
        arp_onsets.append(t)
        if C['datacenter_reveal'] <= t and k % 2 == 0:
            rt = midi(roots[min(bar, len(roots) - 1)])
            yb = I.pluck(rt, 0.4, 0.15, f'bass{k}', pw_odd=0.2)
            yb += 0.6 * np.sin(TAU * hz(rt) * tvec(len(yb))) * np.exp(-tvec(len(yb)) / 0.18)
            gb = -15.0 if not in_card else -22.0 - 8 * np.clip((t - (c1o - 2.0)) / (AF - (c1o - 2.0)), 0, 1)
            mx.add('music', t, yb, gb, 0.0, {'hall': 0.1})
        k += 1
        t = SS + k * sixteenth
    for t, kind in ((C['gpu_hud'], 'line'), (C['gpu_hud'] + 0.2, 'text'), (C['datacenter_hud'], 'text')):
        mx.add('sfx', t, X.hud_blip(f'hud{t}', kind), -30.0, 0.3, {'room': 0.2})
    # datacenter hum (span A)
    HC = C['hum_cut']
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
    DR = C['datacenter_reveal']
    fans *= Adb(n, ha, [(ha, -110), (SS, -48), (DR, -30), (c1i, -22), (HC, -18)])
    mains_e = Adb(n, ha, [(ha, -110), (SS, -48), (DR, -28), (c1i, -23), (HC, -19)])
    coil *= Adb(n, ha, [(ha, -110), (SS + 2, -52), (DR, -44), (HC, -38)])
    hum = fans + pan(mains * mains_e, 0.0) + pan(coil, 0.15)
    mx.add('ambience', ha, hum, 0.0, sends={'hall': 0.12})

    # -------------------------------------------------------------------------
    # ACT II - WICK
    # -------------------------------------------------------------------------
    log('act II')
    MS, FC = C['match_strike'], C['flame_catch']
    mx.add('sfx', MS, X.match_strike('m1'), -12.0, sends={'room': 0.3, 'hall': 0.08})
    mx.add('sfx', FC, X.flame_catch('c1'), -20.0, sends={'room': 0.3})
    CB = C['cut_black']
    TR = C['track_right']
    CR, CRE = C['candle_return'], C['candle_reenter']
    PO, PN = C['power_off'], C['power_on']
    cas0, cas1 = C['copy_cascade_start'], C['copy_cascade_end']
    DS, WS0, WS1 = C['desync_start'], C['warm_shift_start'], C['warm_shift_end']
    LF, LS, BS = C['lattice_fade'], C['lean_start'], C['bridge_start']
    ch3i = C['ch3_in']
    # the candle: one continuous flame signal F1 (its digital twin is the same signal)
    fa = FC - 0.4
    n = ns(CB + 0.05 - fa)
    F1, flick = X.flame(n, 'candle', crackle_rate=0.3)
    F1 = F1 / (np.std(F1) * 4.0)
    tt = fa + tvec(n)
    cand_g = Adb(n, fa, [(fa, -110), (FC, -110), (FC + 0.5, -21), (TR, -21), (TR + 4, -26), (cas0 - 1, -27),
                         (cas0 + 1, -36), (CR - 0.06, -36), (CR, -19), (ch3i - 0.56, -19), (ch3i - 0.5, -110),
                         (CRE - 0.5, -110), (CRE + 2.0, -23), (LS, -22), (CB, -21)])
    cand_p = np.interp(tt, [FC, TR, TR + 4, CR - 0.01, CR, ch3i - 0.5, CRE, LS, CB],
                       [0.0, 0.0, -0.65, -0.65, 0.0, 0.0, -0.55, -0.4, -0.3])
    cand_p += 0.04 * smooth_noise(n, 0.2, rng_for('cpan'))
    mx.add('ambience', fa, pan(F1 * cand_g, cand_p), 0.0, sends={'room': 0.22, 'hall': 0.04})
    # piano motif, sparse
    pno(mx, FC + 2.8, 'D4', 0.42, ring=6.0, gain=-11.0, p=-0.05)
    pno(mx, FC + 5.0, 'A4', 0.38, ring=6.0, gain=-11.5, p=-0.05)
    pno(mx, FC + 7.4, 'Bb4', 0.42, ring=8.0, gain=-11.0, p=-0.05)
    pno(mx, C['wax_drip'] - 1.2, 'D3', 0.3, ring=7.0, gain=-12.0, p=-0.05)
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
    dig_g = Adb(nd, da, [(da, -110), (da + 1.0, -24), (C['res_step_4'], -24), (cas0, -25), (CR - 0.06, -25),
                         (CR, -40), (ch3i - 0.56, -40), (ch3i - 0.5, -26), (DS, -26), (WS0, -25), (WS0 + 4, -110)])
    dig_p = np.interp(td, [da, C['copy_2'], C['copy_8'], ch3i], [0.55, 0.55, 0.15, 0.08])
    mx.add('ambience', da, pan(Dg * dig_g, dig_p), 0.0, sends={'room': 0.08, 'hall': 0.1})
    # learning: click-chime at each resolution step
    for j, (key, nt) in enumerate((('res_step_1', 'A5'), ('res_step_2', 'D6'), ('res_step_3', 'E6'),
                                   ('res_step_4', 'A6'))):
        t = C[key]
        mx.add('sfx', t, X.click(f'res{j}', 0.5 + 0.15 * j), -21.0, 0.55, {'room': 0.2})
        mx.add('music', t + 0.012, I.chime(nt, 2.2, f'res{j}', bright=0.25, decay=0.9), -23.0, 0.55,
               {'hall': 0.35})
    # cold sine glimmer
    n = ns(C['seed_enter'] + 1.0 - (da + 0.5))
    sg = I.sine_pad('A5', n, 'glim1', trem=0.5, quant=6) + 0.6 * I.sine_pad('E6', n, 'glim2', trem=0.5, quant=6)
    sg *= Adb(n, da + 0.5, [(da + 0.5, -110), (C['res_step_1'], -46), (C['res_step_4'], -41),
                            (C['card_c2b_in'], -44), (C['seed_enter'] + 1.0, -110)])
    mx.add('music', da + 0.5, sg, 0.0, 0.6, {'hall': 0.4})
    # the copying (imitation): piano phrase answered note-for-note by the machine
    r4 = C['res_step_4'] + 0.7
    pno(mx, r4, 'D4', 0.4, ring=4.0, gain=-11.5, p=-0.55)
    pno(mx, r4 + 0.7, 'A4', 0.37, ring=4.5, gain=-12.0, p=-0.55)
    mx.add('music', r4 + 0.75, I.chime('D5', 2.5, 'imit1', bright=0.1, decay=1.0), -27.0, 0.55, {'hall': 0.35})
    mx.add('music', r4 + 1.45, I.chime('A5', 2.5, 'imit2', bright=0.1, decay=1.0), -27.0, 0.55, {'hall': 0.35})
    # datacenter hum span B (continuous through the power cut; far -> near)
    hb0 = TR - 1.0
    n = ns(CB + 0.05 - hb0)
    fansB = X.fan_noise(n, 'dcB')
    mainsB = X.mains_hum(n, hb0, 'dcB')
    coilB = X.coil_whine(n, hb0, 'dcB')
    near = fansB + pan(mainsB, 0.0) + pan(coilB, 0.2) * 0.4
    far = lp(hp(near, 70.0, 2), 650.0, 2)
    far_e = Adb(n, hb0, [(hb0, -110), (C['res_step_2'], -110), (C['res_step_4'], -42), (C['seed_enter'], -44),
                         (C['copy_2'], -40), (cas0 + 1, -110)])
    near_e = Adb(n, hb0, [(hb0, -110), (C['copy_4'], -110), (cas0, -34), (cas1, -28), (CR - 0.06, -28),
                          (CR, -40), (ch3i - 0.56, -40), (ch3i - 0.5, -27), (WS0 + 4, -28), (LF, -45), (LF + 2, -110)])
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
        mx.add('music', t, I.mallet(nt, 1.8, f'seed{k}', soft=0.35), -27.0, seedpan(t), {'hall': 0.5, 'space': 0.15})
    grain_cloud(mx, 'music', STD - 0.3, STD + 1.6, lambda t: 26.0, ['D6', 'E6', 'A6', 'D7', 'E7'], 'digishimmer',
                (0.02, 0.05), (-37, -31), lambda t: 0.25, {'hall': 0.3}, quant=1.0 / 32, crush=(8000, 6))
    mx.add('sfx', SB, X.tss('seed'), -15.0, -0.45, {'room': 0.3})
    # ...then one beat of silence
    mx.automate(['music', 'ambience'], [(SB + 0.03, 0), (SB + 0.12, -20), (SB + 0.95, -20), (SB + 1.7, 0)])
    mx.automate(['sfx'], [(SB + 0.25, 0), (SB + 0.4, -12), (SB + 0.95, -12), (SB + 1.6, 0)])

    # the copies: stacked dings, cascade, unison choir
    for key, notes, spread in (('copy_2', ['D5', 'A5'], 0.25), ('copy_4', ['D5', 'A5', 'D6', 'E6'], 0.5),
                               ('copy_8', ['D5', 'A5', 'D6', 'E6', 'A6', 'D7', 'E7', 'A7'], 0.85)):
        t = C[key]
        for j, nt in enumerate(notes):
            p = (j / max(1, len(notes) - 1) * 2 - 1) * spread
            mx.add('music', t, I.chime(nt, 3.0, f'{key}{j}', bright=0.5, decay=1.4), -20.0 - 10 * np.log10(len(notes)),
                   p, {'hall': 0.4, 'space': 0.2})
        mx.add('sfx', t, X.click(key, 0.8), -26.0, 0.0, {'room': 0.2})
    # sea of copies: the same digital flame, multiplied (wide, perfectly identical)
    sa = C['copy_2']
    j0 = ns(sa - da)
    seaD = Dg[j0:]
    nsd = len(seaD)
    sea_g = Adb(nsd, sa, [(sa, -110), (sa + 0.02, -31), (C['copy_4'], -29), (C['copy_8'], -29), (cas1, -27),
                          (CR - 0.06, -27), (CR, -40), (ch3i - 0.56, -40), (ch3i - 0.5, -25), (LF - 2, -27),
                          (LF + 2, -110)])
    mx.add('ambience', sa, widen(seaD * sea_g, 'sea', 1.0) * 1.2, 0.0, sends={'hall': 0.3})

    def casc_rate(t):
        return min(500.0, 8.0 * 2 ** ((t - cas0) / 0.33))

    grain_cloud(mx, 'music', cas0, cas1 + 1.2, casc_rate, ['D5', 'A5', 'D6', 'E6', 'A6', 'D7', 'A4', 'D4'],
                'cascade', (0.06, 0.2), (-30, -26), lambda t: 0.3 + 0.7 * np.clip((t - cas0) / 3.0, 0, 1),
                {'hall': 0.5, 'space': 0.3}, quant=1.0 / 96, shape='exp',
                amp_fn=lambda t: (8.0 / casc_rate(t)) ** 0.5 * (1.0 if t < cas1 else max(0, 1 - (t - cas1) / 1.2)) * 1.5)
    # unison choir: perfect, no vibrato, no drift
    chend = WS1 + 2.5
    base = [(CR - 0.06, 0), (CR, -14), (ch3i - 0.56, -14), (ch3i - 0.5, -3), (C['ch3_out'], -3), (DS + 1.0, 0),
            (WS0 + 4.0, 0), (WS1, -14), (chend, -110)]
    choir_note(mx, 'D4', cas0 - 0.5, chend, [(cas0 - 0.5, -110), (cas0 + 1, -24), (cas1, -8)] + base, 0.0, -2.0)
    choir_note(mx, 'A3', cas0 + 1.8, chend, [(cas0 + 1.8, -110), (cas1, -12), (cas1 + 2, -9)] + base, -0.25, -4.0)
    choir_note(mx, 'A4', cas0 + 1.8, chend, [(cas0 + 1.8, -110), (cas1, -12), (cas1 + 2, -9)] + base, 0.25, -5.0)
    choir_note(mx, 'D3', cas0 + 3.0, chend, [(cas0 + 3.0, -110), (cas1 + 1, -12), (cas1 + 3, -8)] + base, 0.0, -4.0)
    choir_note(mx, 'D5', cas0 + 3.0, chend, [(cas0 + 3.0, -110), (cas1 + 1, -14), (cas1 + 3, -10)] + base, 0.0, -8.0)
    # power: off (gated to digital zero) ... on: relay thunk, everything back, identical
    mx.add('sfx', PN, X.relay_thunk('on'), -10.0, 0.0, {'room': 0.35, 'hall': 0.12})
    # candle return: shorter, marked by time
    pno(mx, CR + 0.5, 'A3', 0.34, ring=5.0, gain=-12.0, p=-0.05)
    pno(mx, CR + 1.7, 'D3', 0.3, ring=5.0, gain=-12.5, p=-0.05)

    # -------------------------------------------------------------------------
    # ACT III - MIND
    # -------------------------------------------------------------------------
    log('act III')
    # the one voice that leaves the unison and becomes the cello
    v0 = ch3i - 0.5
    n = ns(CB - v0)
    tt = v0 + tvec(n)
    line = [(v0, 'D4'), (WS0, 'C#4', 2.5), (WS1 - 2.0, 'D4', 0.25), (WS1 - 0.8, 'E4', 0.12), (WS1 - 0.1, 'F4', 0.12),
            (C['card_c4a_out'] - 0.5, 'E4', 0.12), (LF - 0.7, 'D4', 0.12), (LF, 'A3', 0.15), (CRE + 1.0, 'D4', 0.12),
            (CRE + 2.5, 'E4', 0.1), (CRE + 3.0, 'F4', 0.1), (LS + 0.5, 'G4', 0.1), (LS + 1.5, 'A4', 0.12),
            (LS + 3.0, 'Bb4', 0.12), (LS + 4.0, 'A4', 0.1), (LS + 4.8, 'G4', 0.1), (LS + 5.5, 'F4', 0.1),
            (LS + 6.2, 'E4', 0.1), (BS, 'A4', 0.12), (BS + 1.0, 'C#5', 0.12), (CB - 0.3, 'D5', 0.45)]
    pm = I.pitch_curve(line, n, v0)
    drift = -12.0 * ease((tt - DS) / (WS0 - DS)) * (tt < WS0 + 2.6)  # desync: a few cents flat
    drift = drift * np.clip(1 - (tt - WS0) / 2.5, 0, 1) + (tt >= WS0) * 0 + np.where(tt < WS0, 0, 0)
    vrng = rng_for('voice')
    vdepth = 20.0 * ease((tt - (WS0 + 1.0)) / 4.0) * (1 + 0.15 * smooth_noise(n, 0.3, vrng))
    vrate = 5.2 * (1 + 0.05 * smooth_noise(n, 0.4, vrng))
    vib = vdepth * np.sin(np.cumsum(TAU * vrate) / SR)
    jit = 2.0 * smooth_noise(n, 3.0, vrng) * ease((tt - WS0) / 3.0)
    fvoice = 440.0 * 2 ** ((pm - 69) / 12.0) * 2 ** ((drift + vib + jit) / 1200.0)
    amp = Adb(n, v0, [(v0, -110), (v0 + 2.0, -6), (WS0, -6), (WS0 + 2.5, -4), (WS1 - 2, -2), (WS1, -5),
                      (C['card_c4a_out'] - 0.5, -8), (LF, -5), (CRE, -7), (LS, -4), (LS + 4, -2.5), (BS, -2.5),
                      (CB, -2)])
    # bow-change micro dips
    for t, *_ in line[2:]:
        amp *= 1 - 0.18 * np.exp(-((tt - t) / 0.05) ** 2)
    wc = np.clip((tt - (WS0 + 2.0)) / 4.5, 0, 1)
    voice = I.choir_process(I.choir_source(None, n, 0.0, f=fvoice) * amp) * np.cos(wc * np.pi / 2)
    bright = np.interp(tt, [v0, WS1, CRE, BS, CB], [0.3, 0.45, 0.4, 0.7, 0.9])
    cello = I.bowed(fvoice, amp, bright, 'cello', noise=0.03) * np.sin(wc * np.pi / 2)
    vp = np.interp(tt, [v0, LF, CRE + 2, CB], [0.05, 0.05, 0.3, 0.3])
    mx.add('music', v0, voice, -12.0, vp, {'hall': 0.45, 'space': 0.1})
    mx.add('music', v0, cello, -24.0, vp, {'hall': 0.32})
    # HUD: lock-on, then failing
    mx.add('sfx', DS + 0.3, X.hud_blip('desync', 'line'), -30.0, 0.1, {'room': 0.2})
    mx.add('sfx', C['hud_glitch'], X.glitch('hud'), -21.0, 0.1, {'hall': 0.15})
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
    worig = Adb(no, DS - 1.0, [(DS - 1.0, -110), (DS, -25), (WS0, -25), (LF, -23), (CRE, -24), (LS, -22), (CB, -21)])
    warm = (Dorig * np.cos(xw * np.pi / 2) + F2 * np.sin(xw * np.pi / 2)) * worig
    mx.add('ambience', DS - 1.0, pan(warm, np.interp(to, [DS, LF, CRE + 2], [0.08, 0.08, 0.35])), 0.0,
           {'room': 0.2, 'hall': 0.05})
    # self-burn: embers flaking from its own body
    sb = C['self_burn_start']
    grain_cloud(mx, 'sfx', sb, CB, lambda t: 2.0 + 4.0 * np.clip((t - sb) / 8, 0, 1), ['A6', 'D7', 'E7'], 'flake',
                (0.004, 0.012), (-40, -33), 0.25, {'room': 0.2, 'hall': 0.2}, shape='exp')
    mx.add('sfx', sb, X.ember_stroke(CB - sb, 'selfburn', 0.15), -36.0, sends={'room': 0.2})
    # two flames: piano (candle) and cello (warm flame); strings crescendo; accelerating heartbeat
    pno(mx, CRE + 0.3, 'D4', 0.4, ring=4.0, gain=-10.0, p=-0.5)
    pno(mx, CRE + 1.8, 'A4', 0.38, ring=4.0, gain=-10.5, p=-0.5)
    pno(mx, CRE + 3.2, 'Bb4', 0.42, ring=5.0, gain=-10.0, p=-0.5)
    hb_start = CRE + 2.0
    per0, per1 = 1.0, 0.41
    hper = lambda t: per0 * (per1 / per0) ** (np.clip((t - hb_start) / (CB - hb_start), 0, 1) ** 1.2)
    hbt = tempo_times(hb_start, CB - 0.05, hper)
    for k, t in enumerate(hbt):
        x = np.clip((t - hb_start) / (CB - hb_start), 0, 1)
        gap = 0.27 * hper(t)
        for j, (dt, s) in enumerate(((0.0, 1.0), (gap, 0.6))):
            if t + dt < CB:
                mx.add('music', t + dt, X.heartbeat_hit(f'hb3{k}{j}', s), -22.0 + 4.0 * x, 0.0, {'hall': 0.04})
    prog = [(CRE, ['D3', 'A3', 'F4']), (LS, ['Bb2', 'F3', 'A3', 'D4']), (LS + 3.0, ['C3', 'G3', 'E4', 'D5']),
            (LS + 5.0, ['Bb2', 'G3', 'D4', 'F4']), (BS, ['A2', 'E3', 'D4', 'G4', 'A4']),
            (BS + 1.5, ['A2', 'E3', 'C#4', 'G4', 'Bb4', 'E5'])]
    sgain = lambda t: float(np.interp(t, [CRE, LS, BS, CB], [-21.0, -17.5, -14.5, -11.5]))
    for i, (ts, notes) in enumerate(prog):
        te = prog[i + 1][0] if i + 1 < len(prog) else CB
        att = 2.0 if i == 0 else 0.5
        chord(mx, notes, ts - (0 if i == 0 else 0.25), te + 0.3, att=att, rel=0.6, gain=sgain(ts), spread=0.8,
              label=f'two{i}', voices=4)
    # rising high violins on the bridge
    strings(mx, 'E5', BS - 0.5, CB, att=2.0, rel=0.4, gain=-21.0, p=0.2, voices=5, spread=0.8, label='bridgeV',
            fcurve=lambda t: hz('E5') * 2 ** (5 / 12 * ease((t - BS) / (CB - BS))))
    s_bright += [(CRE - 1, 0.2), (CRE, 0.2), (LS, 0.4), (BS, 0.7), (CB, 1.0)]
    s_space += [(CRE - 1, 0.1), (CB, 0.15)]
    # piano arpeggios locked to the heartbeat
    for k, t in enumerate(hbt):
        if t < LS:
            continue
        chs = [c for ts, c in prog if ts <= t + 0.25][-1]
        x = np.clip((t - LS) / (CB - LS), 0, 1)
        for j, dt in enumerate((0.0, hper(t) / 2)):
            if t + dt >= CB - 0.02:
                continue
            nt = chs[(k * 2 + j) % len(chs)]
            m = midi(nt) + (12 if (k + j) % 3 == 2 else 0) + (12 if midi(nt) < 50 else 0)
            pno(mx, t + dt, m, 0.3 + 0.45 * x, ring=1.6, held=0.8, gain=-16.0 + 2 * x, p=-0.45, label='arp3')
    mx.add('ambience', LS, X.wind_gust(3.8, 'lean', -0.5, 0.45), -27.0, sends={'hall': 0.3})
    rs = X.reverse_swell(CB - BS + 0.0, 'bridge', 1500.0, 14000.0, end_fade=0.002)
    mx.add('sfx', BS, rs, -24.0, sends={'hall': 0.1})

    # -------------------------------------------------------------------------
    # EPILOGUE
    # -------------------------------------------------------------------------
    log('epilogue')
    SRt = C['stars_return']
    ep0 = SRt - 0.5
    CO = C['credits_out']
    pend = CO + 1.4
    TG = C['title_glow']
    sus = ['D3', 'A3', 'E4', 'A4', 'D5']
    envE = [(ep0, -110), (SRt + 4, -9), (C['title_xin_heart_start'], -10), (TG, -11), (TG + 2.5, -11), (C['title_out'], -12),
            (C['credits_in'], -15), (CO - 1.0, -19), (pend, -110)]
    for i, nt in enumerate(sus):
        strings(mx, nt, ep0, pend, env=envE, gain=-17.0, p=(i / 4 * 2 - 1) * 0.6, voices=3, label='sus')
    s_bright += [(ep0 - 0.1, 0.2), (TG, 0.25), (TG + 2, 0.35), (pend, 0.2)]
    s_space += [(ep0 - 0.1, 0.6), (pend, 0.6)]
    n = ns(C['title_xin_heart_start'] + 1 - ep0)
    gp = I.glass('E6', n, 'epi1', beat=0.21) + 0.7 * I.glass('A6', n, 'epi2', beat=0.33)
    gp *= Adb(n, ep0, [(ep0, -110), (SRt + 5, -42), (C['title_xin_heart_start'] - 2, -44),
                       (C['title_xin_heart_start'] + 1, -110)])
    mx.add('music', ep0, widen(gp, 'epiglass'), 0.0, sends={'space': 0.7})
    grain_cloud(mx, 'music', ep0, CO, lambda t: 4.0, spool, 'stars2', (0.02, 0.08), (-43, -36), 0.9, {'space': 0.75},
                amp_fn=lambda t: min(1.0, (t - ep0) / 3.0) * (1.0 if t < CO - 3 else max(0, (CO - t) / 3)))
    # a universe full of small fires: warm flickers, pairs, more and more
    fl_rate = lambda t: 0.6 + 10.0 * np.clip((t - SRt - 2) / 14.0, 0, 1) ** 1.5
    grain_cloud(mx, 'sfx', SRt + 1.0, C['title_xin_heart_start'], fl_rate, ['A4', 'E5'], 'fires', (0.003, 0.009),
                (-46, -40), lambda t: 0.1 + 0.85 * np.clip((t - SRt - 2) / 14.0, 0, 1), {'room': 0.1, 'space': 0.4},
                shape='exp')
    n = ns(C['title_xin_heart_start'] - SRt)
    pair, _ = X.flame(n, 'pair', crackle_rate=0.25)
    pair = pair / (np.std(pair) * 4.0) * Adb(n, SRt, [(SRt, -110), (SRt + 2, -44), (SRt + 10, -46),
                                                       (C['title_xin_heart_start'], -110)])
    mx.add('ambience', SRt, np.stack([pair, np.roll(pair, ns(0.37))]) * 0.7, 0.0, sends={'hall': 0.2})
    # the motif, transformed: D - A - E, resting on sus2 (never resolves)
    pno(mx, SRt + 0.5, 'D4', 0.44, ring=8.0, gain=-10.0, sends={'hall': 0.3, 'space': 0.3})
    pno(mx, SRt + 2.5, 'A4', 0.42, ring=8.0, gain=-10.5, sends={'hall': 0.3, 'space': 0.3})
    pno(mx, SRt + 5.0, 'E5', 0.45, ring=10.0, gain=-10.0, sends={'hall': 0.3, 'space': 0.35})
    pno(mx, SRt + 5.0, 'D3', 0.3, ring=10.0, gain=-14.0, sends={'hall': 0.3, 'space': 0.35})
    pno(mx, SRt + 5.05, 'A3', 0.28, ring=10.0, gain=-15.0, sends={'hall': 0.3, 'space': 0.35})
    for dt, nt in ((9.5, 'D5'), (11.0, 'A5'), (12.8, 'E6')):
        n = ns(5.0)
        gg = I.glass(nt, n, 'echo' + nt, beat=0.4) * Adb(n, 0, [(0, -110), (0.08, -33), (1.5, -40), (5.0, -110)])
        mx.add('music', SRt + dt, gg, 0.0, 0.3, {'space': 0.7})
    # title: the heart written in embers, two wick-grass strokes falling, the glow
    h0, h1 = C['title_xin_heart_start'], C['title_xin_heart_end']
    sl = (h1 - h0) / 4
    for k, p in enumerate((-0.25, 0.0, 0.08, 0.3)):
        mx.add('sfx', h0 + k * sl, X.ember_stroke(sl * 0.88, f'heart{k}', p), -29.0, sends={'space': 0.35})
    g0, g1 = C['title_xin_grass_start'], C['title_xin_grass_end']
    for k, (t, p) in enumerate(((g0, -0.12), ((g0 + g1) / 2, 0.12))):
        n = ns(1.2)
        tt_ = tvec(n)
        f = hz('A6') * (hz('D6') / hz('A6')) ** np.clip(tt_ / 0.5, 0, 1)
        y = np.sin(np.cumsum(TAU * f) / SR) * np.exp(-tt_ / 0.35) * (1 - np.exp(-tt_ / 0.01))
        mx.add('music', t, y, -33.0, p, {'space': 0.5})
        mx.add('sfx', t, X.whoosh(0.6, f'grass{k}', peak=0.6, f_lo=1500, f_hi=5000, width_oct=0.8,
                                  pan_from=p, pan_to=p), -40.0, sends={'space': 0.3})
    mx.add('music', TG, I.bell('D3', 14.0, 'title'), -14.0, 0.0, {'hall': 0.2, 'space': 0.8})
    pno(mx, TG, 'D1', 0.7, ring=11.0, gain=-12.0, sends={'hall': 0.3, 'space': 0.5})
    pno(mx, TG, 'D2', 0.6, ring=11.0, gain=-14.0, sends={'hall': 0.3, 'space': 0.5})
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
    mx.add('sfx', EM, X.match_strike('m2'), -11.0, sends={'room': 0.3, 'hall': 0.08})
    EH, EF = C['end_flame_hiss'], C['end_fade']
    n = ns(D - EH)
    F3, _ = X.flame(n, 'end', crackle_rate=0.4)
    F3 = F3 / (np.std(F3) * 4.0) * Adb(n, EH, [(EH, -110), (EH + 0.4, -22), (EF, -23), (EF + 0.5, -110)])
    mx.add('ambience', EH, F3, 0.0, 0.0, {'room': 0.25})
    mx.automate(['music', 'sfx', 'ambience'], [(EF, 0), (EF + 0.5, -110)])

    # -------------------------------------------------------------------------
    # cards: make room (music thins under every visible card)
    # -------------------------------------------------------------------------
    for cd in tl.get('cards', []):
        a, b = cd['in'], cd['out']
        if any(wa <= a and b <= wb for wa, wb in windows) or cd['id'] in ('credits', 'ch2'):
            continue
        mx.automate(['music'], [(a - 0.8, 0), (a, -2.5), (b, -2.5), (b + 0.8, 0)])

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
        mx.add_bus('music', y.astype(np.float32), a, {'hall': 0.3, 'space': spc.astype(np.float32)})
    sp_ = nz_span(mx.choir, ns(0.5))
    if sp_:
        a, b = sp_
        raw = mx.choir[:, a:b].astype(float)
        y = np.stack([decorrelate(I.choir_process(raw[0]), 'choirL'), decorrelate(I.choir_process(raw[1]), 'choirR')])
        mx.add_bus('music', (y * db(-21.0)).astype(np.float32), a, {'hall': 0.5, 'space': 0.15})
    return mx, windows, groups


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
    mix = sum(stems[s].astype(np.float64) for s in stems)
    N = mix.shape[1]
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
        z = mix * gain
        G = M.limiter_gain(z, ceiling_db=-1.3, release=0.35)
        out = z * G
        li = M.integrated_lufs(out)
        log(f'  iter {it}: gain {20 * np.log10(gain):+.2f} dB -> {li:.2f} LUFS, '
            f'max GR {-20 * np.log10(G.min()):.2f} dB')
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
    tS, lS = M.loudness_curve(xf, 3.0)
    for name, (a, b) in {'prologue': (0, 30), 'act I': (30, 92), 'act II': (92, 164), 'act III': (164, 202),
                         'epilogue': (209.5, 248)}.items():
        m = (tS >= a) & (tS < b)
        report.append(f'short-term LUFS {name:9s}: max {lS[m].max():6.1f}, median {np.median(lS[m]):6.1f}')
    report.append('limiter gain reduction > 1 dB (250 ms bins): ' + (', '.join(gr_report) or 'none'))
    report.append(f'render time: {time.time() - T0:.1f} s')
    txt = '\n'.join(report)
    print(txt)
    open(os.path.join(OUT, 'qa', 'report.txt'), 'w').write(txt + '\n')
    M.qa_plots(xf, tl['cues'], windows, os.path.join(OUT, 'qa'), stems=stem_lvls)
    log('done')


if __name__ == '__main__':
    main()
