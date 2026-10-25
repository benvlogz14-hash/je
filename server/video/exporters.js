'use strict';
/**
 * Project exporters so every short can be finished by hand in a full editor:
 *  - .velo  — opens in Velo (the open-source editor Studio is based on)
 *  - FCP7 XML + SRT — imports into Adobe Premiere Pro (File → Import)
 * Both reference the original footage, not the rendered file, so nothing is lost.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const captions = require('./captions');

const W = 1080, H = 1920, FPS = 30;

function animated(base) { return { base }; }

function veloClip(o) {
  return {
    id: String(o.id), type: o.type, mediaId: o.mediaId || '', name: o.name || '', start: o.start, duration: o.duration, in: o.in || 0,
    speed: 1, preservePitch: false, linkId: String(o.linkId || 0), enabled: true,
    posX: animated(o.posX || 0), posY: animated(o.posY || 0), scaleX: animated(o.scale ?? 1), scaleY: animated(o.scale ?? 1),
    rotation: animated(o.rotation || 0), opacity: animated(1), volume: animated(1), uniformScale: true, effects: o.effects || [],
    transIn: { type: 0, duration: 1 }, transOut: { type: 0, duration: 1 }, ...(o.text ? { text: o.text } : {}),
  };
}

/** Build a Velo project for one short: footage on V1/A1, captions as text clips on V2. */
function toVelo({ name, source, info, range, words, style, hook, focusX = 0.5, covers = [], keywords = null }) {
  const st = captions.resolveStyle(style);
  const dur = range.end - range.start;
  const mediaId = 'm1';
  // Velo positions clips relative to sequence centre; scale so the footage fills the 9:16 frame.
  const scale = info.height ? Math.max(W / info.width, H / info.height) : 1;
  const overflowX = Math.max(0, info.width * scale - W);
  const posX = Math.round((0.5 - focusX) * overflowX);
  let nextId = 1;
  const v1 = [veloClip({ id: nextId++, type: 0, mediaId, name: path.basename(source), start: 0, duration: dur, in: range.start, scale, posX, linkId: 1 })];
  const a1 = info.hasAudio ? [veloClip({ id: nextId++, type: 1, mediaId, name: path.basename(source), start: 0, duration: dur, in: range.start, linkId: 1 })] : [];
  const posY = st.position === 'upper' ? -H * 0.3 : st.position === 'center' ? 0 : H * 0.28;
  const hex = (c) => `#ff${String(c || '#ffffff').replace('#', '').toLowerCase()}`;
  // Clip renders size text the subtitle way (Windows line height); Studio sizes it the browser way (em), so convert.
  const em = (size, font) => Math.max(1, Math.round(size / require('./fontnames').emFit(font, captions.HEAVY.has(font)).k));
  const textStyle = (t, size, color, o = {}) => ({ text: t, family: o.font || st.font, pixelSize: em(size, o.font || st.font), bold: captions.HEAVY.has(o.font || st.font), italic: false, color: hex(color), outlineColor: hex(o.outline || st.outline), outlineWidth: Math.round((o.outlineWidth ?? st.outlineWidth) / 2), ...(o.box ? { box: true, boxColor: hex(o.boxColor), boxPad: 18, ...(o.radius ? { boxRadius: o.radius } : {}) } : {}) });
  // Highlight travels with each caption: the spoken word (word timings inside the caption) or chosen keywords.
  const hlMode = ['word', 'keywords'].includes(st.highlightMode) ? st.highlightMode : 'none';
  const kws = hlMode === 'keywords' ? (keywords?.length ? keywords : captions.autoKeywords(words.filter((w) => w.e > range.start && w.s < range.end))) : [];
  const v2 = captions.captionChunks({ words, range, style }).map((c) => ({ ...veloClip({ id: nextId++, type: 3, name: c.text, start: c.start, duration: c.end - c.start, posY, rotation: st.rotate || 0,
    text: { ...textStyle(c.text, st.size, st.primary), hlMode, hlColor: hex(st.highlight), words: c.words, keywords: kws } }), isCaption: true }));
  // The opening banner keeps its own look: font, size, colours, box or outline, rotation, position and capitals.
  const hk = String(st.hookText || '').trim() || hook;
  const hookY = st.hookPosition === 'lower' ? H * 0.28 : st.hookPosition === 'center' ? 0 : -H * 0.36;
  const v3 = hk && st.hook !== false ? [veloClip({ id: nextId++, type: 3, name: 'Hook', start: 0, duration: Math.min(st.hookSeconds, dur), posY: hookY, rotation: st.hookTilt || 0,
    text: textStyle(st.hookUpper ? hk.toUpperCase() : hk, Math.round(st.hookSize || st.size * 0.72), st.hookColor, { font: st.hookFont || st.font, outline: st.hookOutline, outlineWidth: st.hookOutlineWidth, box: st.hookBox, boxColor: st.hookBg, radius: st.hookRadius || 0 }) })] : [];
  // The render's cut-away shots (B-roll) as their own picture-only clips, so you can move, trim or delete them.
  const broll = (covers || []).filter((c) => c.at < range.end && c.at + c.dur > range.start).map((c) => veloClip({ id: nextId++, type: 0, mediaId, name: 'B-roll', start: Math.max(0, c.at - range.start), duration: c.dur, in: c.src, scale, posX: 0 }));
  const track = (type, nm, clips) => ({ type, name: nm, muted: false, locked: false, volume: animated(1), clips });
  return {
    app: 'velo', version: 1,
    media: [{ id: mediaId, path: source, name: path.basename(source), kind: info.hasVideo ? 0 : 1, duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasVideo: info.hasVideo, hasAudio: info.hasAudio, srcIn: 0, srcOut: -1 }],
    sequences: [{ id: 's1', name: name || 'Short', width: W, height: H, fps: FPS, videoTracks: [track(0, 'V1', v1), ...(broll.length ? [track(0, 'B-roll', broll)] : []), track(0, 'Captions', v2), track(0, 'Hook', v3)], audioTracks: [track(1, 'A1', a1)] }],
    openTabs: ['s1'], activeSequence: 's1', nextClipId: String(nextId),
  };
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** Final Cut Pro 7 XML (xmeml v4), the most reliable interchange format Premiere imports. */
function toFcpXml({ name, source, info, range }) {
  const fps = Math.round(info.fps || FPS);
  const ntsc = info.fps && Math.abs(info.fps - Math.round(info.fps)) > 0.01 ? 'TRUE' : 'FALSE';
  const totalFrames = Math.round((info.duration || range.end) * fps);
  const inF = Math.round(range.start * fps), outF = Math.round(range.end * fps), durF = outF - inF;
  const url = pathToFileURL(source).href;
  const rate = `<rate><timebase>${fps}</timebase><ntsc>${ntsc}</ntsc></rate>`;
  const file = `<file id="file-1"><name>${esc(path.basename(source))}</name><pathurl>${esc(url)}</pathurl>${rate}<duration>${totalFrames}</duration>
        <media><video><samplecharacteristics>${rate}<width>${info.width}</width><height>${info.height}</height></samplecharacteristics></video>${info.hasAudio ? '<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>' : ''}</media></file>`;
  const scale = info.height ? Math.round(Math.max(W / info.width, H / info.height) * 100) : 100;
  const vclip = `<clipitem id="clipitem-1"><name>${esc(name)}</name><enabled>TRUE</enabled><duration>${totalFrames}</duration>${rate}<start>0</start><end>${durF}</end><in>${inF}</in><out>${outF}</out>${file}
        <filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype>
        <parameter><parameterid>scale</parameterid><name>Scale</name><valuemin>0</valuemin><valuemax>1000</valuemax><value>${scale}</value></parameter></effect></filter>
        <link><linkclipref>clipitem-1</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>${info.hasAudio ? '<link><linkclipref>clipitem-2</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>1</clipindex></link>' : ''}</clipitem>`;
  const aclip = info.hasAudio ? `<clipitem id="clipitem-2"><name>${esc(name)}</name><enabled>TRUE</enabled><duration>${totalFrames}</duration>${rate}<start>0</start><end>${durF}</end><in>${inF}</in><out>${outF}</out><file id="file-1"/><sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack></clipitem>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence id="sequence-1">
    <name>${esc(name)}</name>
    <duration>${durF}</duration>
    <rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <format><samplecharacteristics><rate><timebase>${FPS}</timebase><ntsc>FALSE</ntsc></rate><width>${W}</width><height>${H}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
        <track>${vclip}</track>
      </video>
      <audio><track>${aclip}</track></audio>
    </media>
  </sequence>
</xmeml>
`;
}

module.exports = { toVelo, toFcpXml };
