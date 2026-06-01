/* =====================================================================
   NASTY VOYEUR 2 ARCHIVES — Tape Deck driver
   Synthesizes AUDIO-LOG NV2-47 in the browser. No audio file is shipped
   or fetched. The 47 seconds are generated locally on each PLAY:
   filtered tape hiss, a motor rumble, and a slow formant that is almost
   a voice. The static is modulated rather than random — per the analysis
   note, the static is structured.

   Markup contract (everything optional except the deck root):

     <div class="tape-deck"
          data-tape-player
          data-duration="47"
          data-transcript="transcript-id">
       ... .tape-counter, .tape-status, .tape-lamp ...
       <div class="tape-controls">
         <button data-action="play">PLAY</button>
         <button data-action="stop">STOP</button>
       </div>
     </div>

   The driver finds its own pieces by class. Missing pieces are skipped,
   so a deck can be as plain or as dressed as the page needs.
   ===================================================================== */

(function () {
    'use strict';

    var AudioCtx = window.AudioContext || window.webkitAudioContext;

    function TapeDeck(root) {
        this.root = root;
        this.duration = parseFloat(root.getAttribute('data-duration')) || 47;

        this.counterEl = root.querySelector('.tape-counter');
        // Prefer a dedicated text span so a status lamp / icon can live
        // alongside the message without being overwritten.
        this.statusEl = root.querySelector('.tape-status__text') ||
                        root.querySelector('.tape-status');
        this.playBtn = root.querySelector('[data-action="play"]');
        this.stopBtn = root.querySelector('[data-action="stop"]');

        // Optional timed transcript elsewhere on the page.
        this.cues = [];
        var transcriptId = root.getAttribute('data-transcript');
        if (transcriptId) {
            this.buildCues(document.getElementById(transcriptId));
        }

        this.ctx = null;
        this.nodes = [];
        this.playing = false;
        this.startTime = 0;
        this.raf = null;

        this.bind();
        this.reset();
    }

    /* Parse "mm:ss" timestamps out of .transcript-line / .ts markup so
       lines can be cued in time with playback. */
    TapeDeck.prototype.buildCues = function (container) {
        if (!container) return;
        var lines = container.querySelectorAll('.transcript-line');
        for (var i = 0; i < lines.length; i++) {
            var ts = lines[i].querySelector('.ts');
            if (!ts) continue;
            var m = /(\d+):(\d+)/.exec(ts.textContent);
            if (!m) continue;
            this.cues.push({
                at: parseInt(m[1], 10) * 60 + parseInt(m[2], 10),
                el: lines[i]
            });
        }
        this.cues.sort(function (a, b) { return a.at - b.at; });
    };

    TapeDeck.prototype.bind = function () {
        var self = this;
        if (this.playBtn) {
            this.playBtn.addEventListener('click', function () {
                if (self.playing) { self.stop('PAUSED — TAPE STILL WARM'); }
                else { self.play(); }
            });
        }
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', function () {
                self.stop('STOPPED');
            });
        }
        // Be a good citizen: silence the deck if the page is hidden.
        document.addEventListener('visibilitychange', function () {
            if (document.hidden && self.playing) self.stop('SUSPENDED');
        });
    };

    /* ---- Audio synthesis ------------------------------------------ */

    TapeDeck.prototype.makeNoise = function (color) {
        // One second of noise, looped. color: 'white' | 'brown'
        var rate = this.ctx.sampleRate;
        var buf = this.ctx.createBuffer(1, rate, rate);
        var d = buf.getChannelData(0);
        if (color === 'brown') {
            var last = 0;
            for (var i = 0; i < rate; i++) {
                var w = Math.random() * 2 - 1;
                last = (last + 0.02 * w) / 1.02;
                d[i] = last * 3.2;
            }
        } else {
            for (var j = 0; j < rate; j++) d[j] = Math.random() * 2 - 1;
        }
        var src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        return src;
    };

    TapeDeck.prototype.buildGraph = function () {
        var ctx = this.ctx;
        var now = ctx.currentTime;
        var dur = this.duration;

        var master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);

        // Tape lead-in / lead-out: rise over 0.6s, hold, fall over 1.3s.
        // The 1.3s tail is deliberate — the waveform continues after the
        // file is said to end.
        master.gain.setValueAtTime(0, now);
        master.gain.linearRampToValueAtTime(0.9, now + 0.6);
        master.gain.setValueAtTime(0.9, now + dur);
        master.gain.linearRampToValueAtTime(0.0001, now + dur + 1.3);

        // 1) Hiss: white noise through a bandpass — the magnetic floor.
        var hiss = this.makeNoise('white');
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600;
        bp.Q.value = 0.6;
        var hissGain = ctx.createGain();
        hissGain.gain.value = 0.22;
        hiss.connect(bp).connect(hissGain).connect(master);

        // 2) Structured modulation: a slow LFO on the hiss level so the
        //    static breathes. Non-random. This is the "structure."
        var lfo = ctx.createOscillator();
        lfo.frequency.value = 0.47;            // 47 again. it keeps happening.
        var lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.09;
        lfo.connect(lfoGain).connect(hissGain.gain);

        // 3) Motor rumble: brown noise through a lowpass — the reels turning.
        var rumble = this.makeNoise('brown');
        var lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 90;
        var rumbleGain = ctx.createGain();
        rumbleGain.gain.value = 0.18;
        rumble.connect(lp).connect(rumbleGain).connect(master);

        // 4) The almost-voice: a low formant pair that wanders, gated far
        //    down. Present, never quite intelligible.
        var voice = ctx.createOscillator();
        voice.type = 'sawtooth';
        voice.frequency.value = 110;
        var formant = ctx.createBiquadFilter();
        formant.type = 'bandpass';
        formant.frequency.value = 700;
        formant.Q.value = 5;
        var voiceGain = ctx.createGain();
        voiceGain.gain.value = 0.0;
        // breathe the voice in around the transcript's spoken stretch
        voiceGain.gain.setValueAtTime(0, now);
        voiceGain.gain.linearRampToValueAtTime(0.05, now + 8);
        voiceGain.gain.linearRampToValueAtTime(0.05, now + 38);
        voiceGain.gain.linearRampToValueAtTime(0.0, now + 44);
        voice.connect(formant).connect(voiceGain).connect(master);
        // wander the formant so it reads as language, not a tone
        var wander = ctx.createOscillator();
        wander.frequency.value = 0.3;
        var wanderGain = ctx.createGain();
        wanderGain.gain.value = 320;
        wander.connect(wanderGain).connect(formant.frequency);

        [hiss, lfo, rumble, voice, wander].forEach(function (n) { n.start(now); });

        this.nodes = [hiss, lfo, rumble, voice, wander];
        this.master = master;
    };

    TapeDeck.prototype.teardownAudio = function () {
        var now = this.ctx ? this.ctx.currentTime : 0;
        this.nodes.forEach(function (n) {
            try { n.stop(now + 0.05); } catch (e) { /* already stopped */ }
        });
        this.nodes = [];
        if (this.master) {
            try { this.master.gain.cancelScheduledValues(now); } catch (e) {}
            try { this.master.gain.setTargetAtTime(0.0001, now, 0.05); } catch (e) {}
        }
    };

    /* ---- Transport ------------------------------------------------ */

    TapeDeck.prototype.play = function () {
        if (this.playing) return;
        this.playing = true;

        // Immediate, gesture-time UI feedback. The audio itself may take a
        // beat to wake on browsers that hand back a suspended context.
        this.root.classList.remove('is-ended');
        this.root.classList.add('is-playing');
        if (this.playBtn) {
            this.playBtn.setAttribute('aria-pressed', 'true');
            this.playBtn.textContent = '❚❚ PAUSE TRANSMISSION';
        }
        this.setStatus('PLAYING — 1983 ORIGINAL');

        if (!AudioCtx) {
            // No Web Audio at all: still run the visual transport.
            this.setStatus('NO AUDIO SUBSYSTEM — REELS TURN ANYWAY');
            this.startTime = performance.now() / 1000;
            this.tick();
            return;
        }

        var self = this;
        try {
            if (!this.ctx) this.ctx = new AudioCtx();
            // iOS / Safari keep the deck mute until a node has actually run
            // inside the user gesture — a one-sample silent blip unlocks it.
            this.unlock();
            // Build and start only once the clock is truly running. resume()
            // is asynchronous on the browsers that need it; firing the graph
            // before it resolves and ignoring the promise is exactly how a
            // deck ends up spinning in silence.
            if (this.ctx.state === 'suspended' && this.ctx.resume) {
                this.ctx.resume().then(function () { self.startAudio(); },
                                       function () { self.startAudio(); });
            } else {
                this.startAudio();
            }
        } catch (e) {
            this.setStatus('AUDIO SUBSYSTEM UNAVAILABLE — STATIC PERSISTS REGARDLESS');
            this.startTime = (this.ctx ? this.ctx.currentTime : performance.now() / 1000);
            this.tick();
        }
    };

    // Build the synth graph and start the transport clock together, so the
    // counter and cues track what is heard rather than when the click landed.
    TapeDeck.prototype.startAudio = function () {
        if (!this.playing) return;          // stopped during the resume hop
        this.buildGraph();
        this.startTime = this.ctx.currentTime;
        this.tick();
    };

    // A single silent sample, started inside the user gesture, to wake the
    // browsers that won't emit sound until the context has run at least once.
    TapeDeck.prototype.unlock = function () {
        try {
            var s = this.ctx.createBufferSource();
            s.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
            s.connect(this.ctx.destination);
            s.start(0);
        } catch (e) { /* non-fatal */ }
    };

    TapeDeck.prototype.now = function () {
        var base = this.ctx ? this.ctx.currentTime : performance.now() / 1000;
        return base - this.startTime;
    };

    TapeDeck.prototype.tick = function () {
        var self = this;
        var t = this.now();

        if (t >= this.duration) {
            this.end();
            return;
        }

        this.renderCounter(t);
        this.renderCues(t);
        this.raf = requestAnimationFrame(function () { self.tick(); });
    };

    // Natural end of the recording.
    TapeDeck.prototype.end = function () {
        this.teardownAudio();
        this.playing = false;
        cancelAnimationFrame(this.raf);
        this.renderCounter(this.duration);
        this.clearCues();
        this.resetButton();

        // Per the file: the reels keep turning 1.3s after the file ends.
        var self = this;
        this.root.classList.add('is-ended');
        this.setStatus('END OF TRANSMISSION');
        setTimeout(function () {
            self.root.classList.remove('is-playing');
            self.setStatus('RECORDING ENDS — WAVEFORM CONTINUES');
        }, 1300);
    };

    // User-initiated stop / pause.
    TapeDeck.prototype.stop = function (label) {
        this.teardownAudio();
        this.playing = false;
        cancelAnimationFrame(this.raf);
        this.root.classList.remove('is-playing', 'is-ended');
        this.clearCues();
        this.resetButton();
        this.renderCounter(0);
        this.setStatus(label || 'STOPPED');
    };

    TapeDeck.prototype.reset = function () {
        this.renderCounter(0);
        this.setStatus('READY — 1983 ORIGINAL');
    };

    TapeDeck.prototype.resetButton = function () {
        if (!this.playBtn) return;
        this.playBtn.setAttribute('aria-pressed', 'false');
        this.playBtn.textContent = '▶ PLAY TRANSMISSION';
    };

    /* ---- Render helpers ------------------------------------------- */

    TapeDeck.prototype.renderCounter = function (t) {
        if (!this.counterEl) return;
        t = Math.max(0, Math.min(this.duration, t));
        var mm = Math.floor(t / 60);
        var ss = Math.floor(t % 60);
        this.counterEl.textContent =
            (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    };

    TapeDeck.prototype.renderCues = function (t) {
        if (!this.cues.length) return;
        var active = null;
        for (var i = 0; i < this.cues.length; i++) {
            if (this.cues[i].at <= t) active = this.cues[i];
        }
        for (var j = 0; j < this.cues.length; j++) {
            this.cues[j].el.classList.toggle('is-cued', this.cues[j] === active);
        }
    };

    TapeDeck.prototype.clearCues = function () {
        for (var i = 0; i < this.cues.length; i++) {
            this.cues[i].el.classList.remove('is-cued');
        }
    };

    TapeDeck.prototype.setStatus = function (text) {
        if (this.statusEl) this.statusEl.textContent = text;
    };

    /* ---- Auto-init ------------------------------------------------ */

    function init() {
        var decks = document.querySelectorAll('[data-tape-player]');
        for (var i = 0; i < decks.length; i++) new TapeDeck(decks[i]);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.TapeDeck = TapeDeck;
})();
