# 《芯》XIN v2 — score & sound design (all code, no samples)
Run: `python3 audio/score.py` (≈3–4 min, 4 cores) → `out/score.wav` (48 kHz/24-bit stereo, exactly
`timeline.duration`), float stems `out/stems/{music,sfx,ambience}.wav`, QA in `out/qa/` (`report.txt`,
`loudness.png`, `spectrogram.png`, `zoom.png`). Every sync point is read from `timeline.json` (`cues`, `cards`,
`events`), so re-running after an edit re-syncs. Deterministic: all randomness is seeded from stable labels.

**Concept.** D Dorian. Motif D → A → B♭ (the minor sixth: a question) belongs to the candle's piano; the machine
answers in sines and a perfectly tuned unison choir. There is ONE climax, at `cut_black`: from the first install
line the score builds without release (install tones cold → glass → piano, heartbeat, choir voice → cello, string
layers, brass, shimmer) to the loudest, densest frame of the film, then digital zero. The ignition is held back
(≈ −13 LUFS short-term vs ≈ −9 at the climax). Under the Zhuangzi epigraph the motif becomes D → A → E on an
unresolved sus2.
**Instruments** (`instruments.py`, `fx.py`): sub drone; glass harmonica; granular star shimmer; additive piano
(inharmonic partials, two-stage decay, unison detune, hammer); bowed cello (band-limited additive Helmholtz saw,
bow noise, body resonances); PolyBLEP string section (dark/bright cross-fade, ff saturation); formant choir; bell;
arp plucks; brass pad; sine chimes. FX/foley: candle (low flutter, rare crackles) and its digitised twin (the
same signal, zero-order-hold + bit-crushed); datacenter hum (fans, blade-pass, 50 Hz series, coil whine); power
brown-out sag + relay thunk; match strike; sub drop/boom/impact; whooshes; reverse swells; suck-out; heartbeat;
neural crackle; HUD typing/glitch; embers.

**Cue map.** `first_star` ting + a ping per `astra_star_ignitions` + accelerating shimmer · tick per
`astra_line_ticks` · glare, pass-bys, riser → `drift_start` bowed fifth + rising embers (no motif) ·
`collapse_start`→`implode` accelerating ostinato, swirling rumble, string glissandi · 0.36 s suck-out, vacuum ·
`ignite` (held back) · star plasma, B♭maj9; HUD tables typed at each `*_hud` · `pullback_start` whoosh,
`earth_arrive` G/D, `sunrise` glass · `brain_form` heartbeat/crackle/glass pulses · `silicon_snap` → 16th
arpeggio, hum rising · `spark_rise` arp dissolves, one A6 spark tone until `spark_out` · `hum_cut` cut ·
`match_strike`, `flame_catch`, sparse piano motif, `wax_drip` · digital twin in 5 resolutions, click-chime per
`res_step_*`, piano phrase copied by sines · seed chimes; `seed_burn` tss + one silent beat · `copy_2/4/8` dings →
cascade → unison choir · `power_sag` frames, `power_off`/`power_on` (everything returns phase-identical) ·
`install_1/2/3` D5 cold square-sine → A5 glass → B♭ piano · `desync_start` heartbeat enters (accelerates to
the cut), voice drifts flat · `hud_glitch`; across `warm_shift` the voice slides a semitone and becomes the cello;
flame twin → real flame; `self_burn_start` embers + low strings · `candle_reenter` piano asks D-A-B♭ ·
`lean_start` gust, violins, heartbeat-locked piano · `verdict_label` typed, Gm9 + brass · `bridge_start` A7sus4 →
A7(♭9), rising violins, swell; the cello glides C♯→D and is cut before arriving · silence to `stars_return`−0.5 ·
`zhuangzi_in` D-A-E/sus2, `zhuangzi_dissolve` embers into the small fires · title strokes, `title_glow` bell ·
credits pad, out before `session_log_in` · `end_match_strike`, `end_flame_hiss`, faded by `end_fade`+0.5.

**Mix/master.** FFT-convolution reverbs from synthesised IRs, rendered per audible segment (no tail crosses a
cut); mono lows. BS.1770-4 gated loudness → −16 LUFS; 4×-oversampled soft clipper (−6 dBFS knee) then a 4×
true-peak look-ahead limiter (−1.3 dBTP); silence gates applied last (every window verified sample-exact zero).
