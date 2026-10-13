#pragma once
#include <QApplication>
#include <QIcon>

namespace Theme {
void apply(QApplication &app);

// Bundled monochrome SVG icon (resources/icons/<name>.svg), cached.
// All UI glyphs come from here so they render identically on every OS.
QIcon icon(const QString &name);

// shared palette constants for custom-painted widgets
// Euclidean theme: mostly white, cool greys, muted pastel accents (teal, gold, moss, lavender).
inline QColor panel() { return QColor(0xf7, 0xf8, 0xf9); }
inline QColor panelDark() { return QColor(0xec, 0xee, 0xf1); }
inline QColor border() { return QColor(0xd3, 0xd7, 0xdc); }
inline QColor accent() { return QColor(0x3f, 0x9a, 0x92); }
inline QColor textDim() { return QColor(0x8a, 0x92, 0x9b); }
inline QColor text() { return QColor(0x1c, 0x20, 0x24); }
inline QColor videoClip() { return QColor(0xb9, 0xdd, 0xd8); }
inline QColor audioClip() { return QColor(0xcf, 0xe1, 0xc9); }
inline QColor textClip() { return QColor(0xe7, 0xdc, 0xf2); }
inline QColor nestedClip() { return QColor(0xf3, 0xe2, 0xb8); }
inline QColor imageClip() { return QColor(0xd6, 0xe6, 0xf0); }
inline QColor laneVideo() { return QColor(0xe3, 0xe6, 0xea); }
inline QColor laneAudio() { return QColor(0xdd, 0xe1, 0xe6); }
inline QColor headSelected() { return QColor(0xe1, 0xf2, 0xef); }
inline QColor buttonOff() { return QColor(0xe4, 0xe6, 0xe9); }
inline QColor buttonOn() { return QColor(0xd0, 0x71, 0x5f); }
inline QColor playhead() { return QColor(0xd0, 0x71, 0x5f); }
inline QColor keyframe() { return QColor(0xc9, 0xa0, 0x43); }
}  // namespace Theme
