# 《芯》XIN — score & sound design (all code, no samples)
Run: `python3 film/audio/score.py` (≈2.5 min on 4 cores) → `film/out/score.wav` (48 kHz/24-bit stereo, exactly
`timeline.duration`), float stems in `out/stems/` (music, sfx, ambience) and QA in `out/qa/` (`report.txt`,
`spectrogram.png`, `loudness.png`). All sync points come from `timeline.json` (`cues`, `cards`, `events`, the S03
shot start); move a cue and re-run to re-sync. Deterministic: every random source is seeded by a stable label.

**Concept.** D Dorian. The leitmotif D → A → B♭ (a minor sixth: a question) belongs to the candle's piano. The machine
answers in pure sines and a perfectly tuned choir. In Act III one choir voice drifts flat, slides a semitone down,
grows vibrato and turns into the warm cello. The climax hangs on A7(♭9), with the cello gliding C♯→D, and is cut
before it resolves. The epilogue turns the motif into D → A → E and rests on an unresolved sus2. Silence is
structural: every required window is digital zero, reverb tails included.

**Instruments** (`instruments.py`, `fx.py`): sub drone; glass harmonica (beating sines); granular star shimmer;
additive piano (inharmonic partials, two-stage decay, unison detune, hammer); bowed cello (band-limited additive
Helmholtz saw, bow noise, body resonances); PolyBLEP string section (dark/bright cross-fade, body EQ); formant
choir (zero vibrato); bell; arp plucks; brass pad; sine chimes. FX/foley: flame (hiss, flutter, wick crackle)
and its digitised twin (the *same* signal, zero-order-hold + bit-crushed); datacenter hum (shaped fan noise,
blade-pass tones, 50 Hz mains series, load-modulated coil whine); match strike; relay thunk; sub drop; impact;
whooshes; reverse swells; suck-out; heartbeat; neural crackle; HUD blips and glitch; embers.

**Cue map.** `first_star` ting + 12 `astra_star_ignitions` pings in the accelerating shimmer · one tick per
`astra_line_ticks` · glare whoosh in the hold · star pass-bys + reverse swell + riser into 20.0 · motif D-A-B♭ under
the epigraph · `collapse_start`→`implode`: accelerating ostinato, swirling rumble, rising string glissandi ·
`implode`: 0.36 s suck-out, then vacuum · `ignite`: sub drop 60→25 Hz, boom, bright burst, 11 s space reverb,
full Dm(add9) · star: plasma roar, B♭maj9 → Csus2 · `pullback_start` whoosh · `earth_arrive` G/D (the Dorian B♮),
`sunrise` glass · `brain_form` heartbeat + neural crackle + glass pulses · `silicon_snap` snap → 16th arpeggio,
hum rising · cards thin the music (−2.5 dB + sparser writing) · `hum_cut` hard cut · `match_strike`/`flame_catch`
· piano motif · `wax_drip` · digital twin in 5 resolutions with click-chime per `res_step_*` · piano phrase
copied note-for-note by sines · seed chimes follow the seed's pan path; `seed_burn` "tss" + one silent beat ·
`copy_2/4/8` stacked dings → exponential ding cascade into the unison choir · `power_off`/`power_on` gated
silence, relay thunk, hum/choir/flames return phase-identical (they never stopped underneath) · `candle_return`
· `desync_start` voice drift + flame delay drift, `hud_glitch`, `warm_shift` digital→real flame + cello morph,
`self_burn_start` embers · `candle_reenter`: piano ↔ cello duet, accelerating heartbeat, `lean_start` gust,
`bridge_start` violins + swell · `cut_black` hard cut · `stars_return` D-A-E on Dsus2, warm flame flickers
multiplying · heart strokes in embers, two falling grass tones, `title_glow` low bell + piano D1/D2 bloom ·
credits pad · `end_match_strike` + `end_flame_hiss`, faded by `end_fade`+0.5.

**Mix/master.** FFT-convolution reverbs from synthesised IRs (room/hall/space), rendered per audible segment so no
tail crosses a cut; decorrelated highs, mono lows. BS.1770-4 gated loudness → −16 LUFS; 4× oversampled look-ahead
true-peak limiter (−1.3 dBTP); silence gates applied last.
