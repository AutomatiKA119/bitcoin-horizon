export const PLAYLIST = [
  { file: "midi/glass-runway.mid", title: "GLASS RUNWAY" },
  { file: "midi/sodium-lights.mid", title: "SODIUM LIGHTS" },
  { file: "midi/afterburn.mid", title: "AFTERBURN" },
  { file: "midi/cable-city.mid", title: "CABLE CITY" },
  { file: "midi/red-shift.mid", title: "RED SHIFT" },
  { file: "midi/night-market.mid", title: "NIGHT MARKET" },
];

function readVLQ(view, offset) {
  let value = 0;
  let byte = 0;
  do {
    byte = view.getUint8(offset++);
    value = (value << 7) | (byte & 0x7f);
  } while (byte & 0x80);
  return { value, offset };
}

function parseTrack(view, offset, end, division) {
  const events = [];
  let tick = 0;
  let running = 0;
  while (offset < end) {
    const delta = readVLQ(view, offset);
    offset = delta.offset;
    tick += delta.value;
    let status = view.getUint8(offset);
    if (status < 0x80) {
      status = running;
    } else {
      offset += 1;
      if (status < 0xf0) running = status;
    }
    if (status === 0xff) {
      const type = view.getUint8(offset++);
      const length = readVLQ(view, offset);
      offset = length.offset;
      if (type === 0x51 && length.value === 3) {
        const tempo = (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
        events.push({ tick, tempo });
      }
      offset += length.value;
      continue;
    }
    if (status === 0xf0 || status === 0xf7) {
      const length = readVLQ(view, offset);
      offset = length.offset + length.value;
      continue;
    }
    const kind = status & 0xf0;
    const channel = status & 0x0f;
    const data0 = view.getUint8(offset++);
    let data1 = 0;
    if (kind !== 0xc0 && kind !== 0xd0) data1 = view.getUint8(offset++);
    if (kind === 0x90 || kind === 0x80) {
      events.push({ tick, kind, channel, note: data0, vel: data1 });
    }
  }
  return { events, division };
}

export function parseMidi(buffer) {
  const view = new DataView(buffer);
  const division = view.getUint16(12);
  let offset = 14;
  const merged = [];
  while (offset + 8 <= view.byteLength) {
    const type = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    const length = view.getUint32(offset + 4);
    offset += 8;
    if (type === "MTrk") {
      merged.push(...parseTrack(view, offset, offset + length, division).events);
    }
    offset += length;
  }
  merged.sort((a, b) => a.tick - b.tick);
  let us = 500000;
  let lastTick = 0;
  let ms = 0;
  const open = new Map();
  const notes = [];
  for (const event of merged) {
    ms += ((event.tick - lastTick) * us) / division / 1000;
    lastTick = event.tick;
    if (event.tempo) {
      us = event.tempo;
      continue;
    }
    const key = `${event.channel}:${event.note}`;
    const on = event.kind === 0x90 && event.vel > 0;
    if (on) {
      open.set(key, { channel: event.channel, note: event.note, vel: event.vel, start: ms });
    } else if (open.has(key)) {
      const note = open.get(key);
      open.delete(key);
      notes.push({ ...note, end: ms });
    }
  }
  const duration = notes.reduce((max, note) => Math.max(max, note.end), 0);
  return { notes, duration };
}

function tone(ctx, destination, type, freq, when, dur, vel, attack = 0.01) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, when);
  const peak = Math.max(0.0001, vel);
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(attack + 0.02, dur));
  osc.connect(gain);
  gain.connect(destination);
  osc.start(when);
  osc.stop(when + dur + 0.05);
  return { osc, gain };
}

function noiseBurst(ctx, destination, when, dur, vel, highpass) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = highpass;
  const gain = ctx.createGain();
  gain.gain.value = vel;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(when);
  return { osc: source, gain };
}

export function createRadio(playlist) {
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.22;
  const delay = ctx.createDelay();
  delay.delayTime.value = 0.22;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.28;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(feedback);
  feedback.connect(delay);
  delay.connect(wet);
  wet.connect(master);
  master.connect(ctx.destination);

  const state = {
    playlist,
    index: 0,
    offset: 0,
    startedAt: 0,
    nodes: [],
    timer: 0,
    playing: false,
    title: "STANDBY",
  };

  function freq(note) {
    return 440 * 2 ** ((note - 69) / 12);
  }

  function playNote(note, when, dur) {
    const vel = (note.vel / 127) * 0.18;
    if (note.channel === 9) {
      if (note.note === 36) {
        const kick = tone(ctx, master, "sine", 140, when, Math.min(0.18, dur), vel * 1.4, 0.005);
        kick.osc.frequency.exponentialRampToValueAtTime(46, when + 0.12);
        state.nodes.push(kick);
      } else if (note.note === 38) {
        state.nodes.push(noiseBurst(ctx, master, when, 0.12, vel * 0.7, 800));
        state.nodes.push(tone(ctx, master, "triangle", 180, when, 0.08, vel * 0.4, 0.002));
      } else {
        state.nodes.push(noiseBurst(ctx, master, when, 0.04, vel * 0.35, 5000));
      }
      return;
    }
    const dest = note.channel === 0 ? master : delay;
    if (note.channel === 0) {
      const bass = tone(ctx, dest, "sawtooth", freq(note.note), when, dur, vel * 0.7, 0.01);
      bass.osc.detune?.setValueAtTime?.(-4, when);
      state.nodes.push(bass);
      state.nodes.push(tone(ctx, dest, "square", freq(note.note) / 2, when, dur, vel * 0.15, 0.01));
    } else if (note.channel === 1) {
      state.nodes.push(tone(ctx, dest, "triangle", freq(note.note), when, dur, vel * 0.45, 0.18));
      state.nodes.push(tone(ctx, dest, "sine", freq(note.note) * 1.005, when, dur, vel * 0.25, 0.22));
    } else if (note.channel === 2) {
      state.nodes.push(tone(ctx, dest, "square", freq(note.note), when, Math.min(dur, 0.18), vel * 0.35, 0.005));
    } else {
      state.nodes.push(tone(ctx, dest, "sawtooth", freq(note.note), when, dur, vel * 0.32, 0.02));
    }
  }

  function stopNodes() {
    for (const node of state.nodes) {
      try { node.gain.gain.cancelScheduledValues(ctx.currentTime); node.gain.gain.setValueAtTime(0.0001, ctx.currentTime); } catch { /* already stopped */ }
      try { node.osc.stop(); } catch { /* already stopped */ }
    }
    state.nodes = [];
    clearTimeout(state.timer);
  }

  async function load(index) {
    const track = playlist[index];
    const response = await fetch(track.file);
    if (!response.ok) throw new Error(`MIDI missing: ${track.file}`);
    state.song = parseMidi(await response.arrayBuffer());
    state.index = index;
    state.title = track.title;
  }

  function schedule(offsetMs) {
    stopNodes();
    const song = state.song;
    const offset = Math.min(Math.max(0, offsetMs), Math.max(0, song.duration - 250));
    state.offset = offset;
    state.startedAt = performance.now() - offset;
    const when0 = ctx.currentTime + 0.06;
    for (const note of song.notes) {
      if (note.end <= offset) continue;
      const start = when0 + Math.max(0, note.start - offset) / 1000;
      const dur = (note.end - Math.max(note.start, offset)) / 1000;
      playNote(note, start, dur);
    }
    state.playing = true;
    state.timer = setTimeout(() => {
      const next = (state.index + 1) % playlist.length;
      load(next).then(() => schedule(0)).catch(() => { state.playing = false; });
    }, song.duration - offset);
  }

  return {
    state,
    async startRandom() {
      await ctx.resume();
      if (ctx.state !== "running") throw new Error("autoplay blocked");
      const index = Math.floor(Math.random() * playlist.length);
      await load(index);
      const span = state.song.duration * 0.85;
      schedule(Math.random() * span);
    },
    async toggle() {
      if (state.playing) {
        const elapsed = performance.now() - state.startedAt;
        stopNodes();
        state.playing = false;
        state.offset = elapsed;
        return;
      }
      await ctx.resume();
      if (!state.song) await this.startRandom();
      else schedule(state.offset);
    },
    position() {
      if (!state.playing) return state.offset || 0;
      return performance.now() - state.startedAt;
    },
  };
}

export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
