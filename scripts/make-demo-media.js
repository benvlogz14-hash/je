'use strict';
/**
 * Generates a demo "long-form" video for rehearsing the pipeline without
 * client footage: a 16:9 talking-segment style video with synthesized speech
 * (FFmpeg's flite voice when available) and a matching word-timed transcript
 * file, so captions can be tested without an AI key.
 *   node scripts/make-demo-media.js [outDir]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const LINES = [
  'Welcome back to the channel. Today we are talking about why local news matters more than ever.',
  'Here is the thing nobody tells you. Most towns lost their newspaper years ago, and nobody replaced it.',
  'So who covers the zoning board? Who shows up when the school budget gets cut? Usually, nobody does.',
  'That is exactly why we started filming every meeting ourselves. And the response has been unreal.',
  'Last week one clip from a council meeting hit two hundred thousand views in a single day.',
  'People want to know what is happening down the street, not just in Washington.',
  'If you take one thing from this video, it is this. Show up, film it, and share it.',
  'Now, a lot of you asked how we actually get the footage. Honestly, it is just a phone and a tripod.',
  'We get there early, we sit in the front row, and we record the whole thing start to finish.',
  'Then we cut the best moments into short clips, and those clips do the heavy lifting.',
  'The craziest part? Officials started watching. One even changed a vote after a clip went viral.',
  'That is the power of just paying attention, out loud, where everyone can see it.',
  'We are not a big newsroom. We are a few people with cameras who refuse to look away.',
  'And if we can do it here, you can absolutely do it in your town too.',
  'Drop a comment with your town, and we might cover your next meeting. See you next time.',
];

function main() {
  const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'demo-media'));
  fs.mkdirSync(outDir, { recursive: true });
  const filters = execFileSync('ffmpeg', ['-hide_banner', '-filters']).toString();
  const hasFlite = / flite /.test(filters);
  const parts = []; const words = []; let t = 0.6;
  for (let i = 0; i < LINES.length; i++) {
    const wav = path.join(outDir, `line${i}.wav`);
    if (hasFlite) {
      const txt = path.join(outDir, `line${i}.txt`); fs.writeFileSync(txt, LINES[i]);
      execFileSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', `flite=textfile='${txt.replace(/\\/g, '/').replace(/'/g, '')}':voice=slt`, '-ar', '48000', '-ac', '2', wav], { stdio: 'ignore' });
      fs.unlinkSync(txt);
    } else {
      execFileSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=${220 + i * 30}:duration=${2 + LINES[i].length / 18}`, '-ar', '48000', '-ac', '2', wav], { stdio: 'ignore' });
    }
    const dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', wav]).toString().trim());
    // Spread the words across the spoken duration, weighted by length (approximate alignment).
    const ws = LINES[i].split(/\s+/); const total = ws.reduce((s, w) => s + w.length + 1, 0);
    let wt = t + 0.08; const speak = dur - 0.16;
    for (const w of ws) { const d = speak * (w.length + 1) / total; words.push({ w, s: +wt.toFixed(3), e: +(wt + d * 0.92).toFixed(3) }); wt += d; }
    parts.push({ wav, start: t, dur });
    t += dur + (i % 3 === 2 ? 1.6 : 0.7);
  }
  const total = t + 0.8;
  // Assemble the audio bed with gaps, then put it under a moving 16:9 picture.
  const inputs = parts.flatMap((p) => ['-i', p.wav]);
  const delays = parts.map((p, i) => `[${i}:a]adelay=${Math.round(p.start * 1000)}|${Math.round(p.start * 1000)}[a${i}]`).join(';');
  const mix = `${parts.map((_, i) => `[a${i}]`).join('')}amix=inputs=${parts.length}:duration=longest:normalize=0[aout]`;
  const audio = path.join(outDir, 'voice.wav');
  execFileSync('ffmpeg', ['-hide_banner', '-y', ...inputs, '-filter_complex', `${delays};${mix}`, '-map', '[aout]', '-t', total.toFixed(2), audio], { stdio: 'ignore' });
  const video = path.join(outDir, 'demo-episode.mp4');
  const pic = `color=c=0x2b3440:s=1920x1080:r=30:d=${total.toFixed(2)}[bg];` +
    `testsrc2=s=760x760:r=30:d=${total.toFixed(2)},hue=s=0.35,format=yuv420p[sq];` +
    `[bg][sq]overlay=x='580+90*sin(t/3)':y=160,drawbox=x=0:y=1010:w=1920:h=70:color=0xf2c14e@0.9:t=fill[v]`;
  execFileSync('ffmpeg', ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-i', audio, '-filter_complex', pic, '-map', '[v]', '-map', '1:a', '-t', total.toFixed(2), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-pix_fmt', 'yuv420p', video], { stdio: 'ignore' });
  for (const p of parts) fs.unlinkSync(p.wav);
  fs.unlinkSync(audio);
  const segments = []; let cur = null;
  for (const w of words) { if (!cur || w.s - cur.e > 0.5) { if (cur) segments.push(cur); cur = { s: w.s, e: w.e, t: w.w }; } else { cur.e = w.e; cur.t += ' ' + w.w; } }
  if (cur) segments.push(cur);
  const transcript = { engine: hasFlite ? 'Demo alignment (synthesized speech)' : 'Demo alignment (tones)', text: LINES.join(' '), words, segments };
  fs.writeFileSync(path.join(outDir, 'demo-episode.transcript.json'), JSON.stringify(transcript, null, 1));
  console.log(JSON.stringify({ video, transcript: path.join(outDir, 'demo-episode.transcript.json'), duration: total, words: words.length, speech: hasFlite ? 'flite' : 'tones' }));
}

main();
