#include "engine/Compositor.h"
#include "effects/Effects.h"
#include <QCryptographicHash>
#include <QFontMetricsF>
#include <QPainter>
#include <QPainterPath>

static double smoothstep(double f) {
    f = qBound(0.0, f, 1.0);
    return f * f * (3.0 - 2.0 * f);
}

QImage Compositor::renderFrame(const QString &seqId, double t, double scale) {
    QMutexLocker lock(m_mutex);
    const Sequence *seq = m_project->sequenceByIdConst(seqId);
    if (!seq) return QImage();
    return renderSequence(*seq, t, scale, 0, true);
}

QSizeF Compositor::clipNativeSize(const Project &p, const Sequence &seq,
                                  const Clip &clip) {
    switch (clip.type) {
    case ClipType::Nested:
        if (const Sequence *sub = p.sequenceByIdConst(clip.mediaId))
            return QSizeF(sub->width, sub->height);
        break;
    case ClipType::Text:
        return textNativeSize(clip.text);
    default:
        if (const MediaItem *m = p.mediaByIdConst(clip.mediaId))
            if (m->width > 0) return QSizeF(m->width, m->height);
    }
    return QSizeF(seq.width, seq.height);
}

QImage Compositor::renderSequence(const Sequence &seq, double t, double scale,
                                  int depth, bool opaqueBg, double speedAbs) {
    const int w = qMax(2, int(seq.width * scale)) & ~1;
    const int h = qMax(2, int(seq.height * scale)) & ~1;
    QImage canvas(w, h, QImage::Format_ARGB32_Premultiplied);
    canvas.fill(opaqueBg ? QColor(Qt::black) : QColor(Qt::transparent));
    if (depth > 8) return canvas;  // nesting recursion guard

    QPainter p(&canvas);
    p.setRenderHint(QPainter::SmoothPixmapTransform, true);
    p.setRenderHint(QPainter::Antialiasing, true);

    for (const Track &track : seq.videoTracks) {  // V1 first = bottom layer
        if (track.muted) continue;
        const Clip *clip = track.clipAt(t);
        if (!clip || !clip->enabled) continue;

        double extra = 1.0;
        // incoming cross dissolve: draw the previous clip fading out first
        const double local = clip->clipLocal(t);
        if (clip->transIn.type == TransitionType::CrossDissolve &&
            local < clip->transIn.duration) {
            double f = smoothstep(local / clip->transIn.duration);
            int idx = track.indexOf(clip->id);
            if (idx > 0) {
                const Clip &prev = track.clips[idx - 1];
                if (prev.enabled && std::abs(prev.end() - clip->start) < 0.05) {
                    // video files have handles past the cut (and hold their
                    // last frame at EOF), but a nested sequence is empty past
                    // its end — clamp so the dissolve holds its last frame
                    // instead of blending from black
                    double pt = t;
                    if (prev.type == ClipType::Nested) {
                        if (const Sequence *sub =
                                m_project->sequenceByIdConst(prev.mediaId)) {
                            const double srcEnd =
                                prev.start + (sub->duration() - prev.in) /
                                                 qMax(1e-9, prev.speed);
                            pt = qMax(prev.start, qMin(t, srcEnd - 1e-3));
                        }
                    }
                    drawClip(p, seq, prev, pt, scale, 1.0 - f, depth, speedAbs);
                }
            }
            extra *= f;
        }
        drawClip(p, seq, *clip, t, scale, extra, depth, speedAbs);
    }
    p.end();
    return canvas;
}

QImage Compositor::clipSource(const Sequence &seq, const Clip &clip, double t,
                              double scale, int depth, double speedAbs) {
    const double srcT = clip.sourceTime(t);
    const double local = clip.clipLocal(t);
    const double effSpeed = speedAbs * std::abs(clip.speed);
    QImage img;
    switch (clip.type) {
    case ClipType::Nested: {
        const Sequence *sub = m_project->sequenceByIdConst(clip.mediaId);
        if (sub)
            img = renderSequence(*sub, srcT, scale, depth + 1, false, effSpeed);
        break;
    }
    case ClipType::Text:
        img = renderText(clip.text, scale);
        break;
    case ClipType::Video:
    case ClipType::Image: {
        const MediaItem *m = m_project->mediaByIdConst(clip.mediaId);
        if (!m || m->offline) break;
        // decode no larger than what ends up on screen
        double sx = qMax(std::abs(clip.scaleX.at(local)), 0.01);
        int maxW = m->width > 0
                       ? qMin(m->width, int(std::ceil(m->width * sx * scale)) + 2)
                       : int(seq.width * scale);
        if (m->kind == MediaKind::Image || m->kind == MediaKind::Svg)
            img = m_cache.stillImage(m->path, m->kind, maxW);
        else
            img = m_cache.videoFrame(m->path, srcT, maxW, effSpeed > 100.0);
        break;
    }
    default:
        break;
    }
    if (img.isNull()) return img;

    // effect chain (modular)
    if (!clip.effects.isEmpty()) {
        bool any = false;
        for (const auto &e : clip.effects)
            if (e.enabled) any = true;
        if (any && img.format() != QImage::Format_ARGB32 &&
            img.format() != QImage::Format_ARGB32_Premultiplied)
            img = img.convertToFormat(QImage::Format_ARGB32);
        if (any) img = img.copy();  // never mutate cached frames
        for (const auto &e : clip.effects) {
            if (!e.enabled) continue;
            const EffectDesc *d = EffectRegistry::instance()->byId(e.effectId);
            if (!d || !d->apply) continue;
            QMap<QString, double> vals;
            for (auto it = e.params.begin(); it != e.params.end(); ++it)
                vals[it.key()] = it.value().at(local);
            d->apply(img, vals, scale);
        }
    }
    return img;
}

void Compositor::drawClip(QPainter &p, const Sequence &seq, const Clip &clip,
                          double t, double scale, double extraOpacity, int depth,
                          double speedAbs) {
    QImage src = clipSource(seq, clip, t, scale, depth, speedAbs);
    if (src.isNull()) return;

    const double local = clip.clipLocal(t);
    const double remain = clip.end() - t;
    double opacity = qBound(0.0, clip.opacity.at(local), 1.0) * extraOpacity;
    double darken = 0.0;  // dip-to-black amount

    if (clip.transIn.type != TransitionType::None && local < clip.transIn.duration) {
        double f = smoothstep(local / qMax(0.05, clip.transIn.duration));
        if (clip.transIn.type == TransitionType::Fade)
            opacity *= f;
        else if (clip.transIn.type == TransitionType::DipToBlack)
            darken = qMax(darken, 1.0 - f);
    }
    if (clip.transOut.type != TransitionType::None && remain < clip.transOut.duration) {
        double f = smoothstep(remain / qMax(0.05, clip.transOut.duration));
        if (clip.transOut.type == TransitionType::Fade ||
            clip.transOut.type == TransitionType::CrossDissolve)
            opacity *= f;
        else if (clip.transOut.type == TransitionType::DipToBlack)
            darken = qMax(darken, 1.0 - f);
    }
    if (opacity <= 0.001) return;

    if (darken > 0.001) {
        src = src.convertToFormat(QImage::Format_ARGB32_Premultiplied).copy();
        QPainter dp(&src);
        dp.setCompositionMode(QPainter::CompositionMode_SourceAtop);
        dp.fillRect(src.rect(), QColor(0, 0, 0, int(darken * 255)));
    }

    QSizeF nat = clipNativeSize(*m_project, seq, clip);
    if (clip.type == ClipType::Text)  // text renders at its own natural size
        nat = QSizeF(src.width() / scale, src.height() / scale);
    const double sx = clip.scaleX.at(local);
    const double sy = clip.uniformScale ? sx : clip.scaleY.at(local);
    const double drawW = nat.width() * sx * scale;
    const double drawH = nat.height() * sy * scale;
    if (drawW < 0.5 || drawH < 0.5) return;

    p.save();
    p.setOpacity(opacity);
    p.translate(p.device()->width() / 2.0 + clip.posX.at(local) * scale,
                p.device()->height() / 2.0 + clip.posY.at(local) * scale);
    p.rotate(clip.rotation.at(local));
    p.drawImage(QRectF(-drawW / 2, -drawH / 2, drawW, drawH), src);
    p.restore();
}

QSizeF Compositor::textNativeSize(const TextStyle &style) {
    QFont font(style.family);
    font.setPixelSize(qMax(4, style.pixelSize));
    font.setBold(style.bold);
    font.setItalic(style.italic);
    QFontMetricsF fm(font);
    const QStringList lines = style.text.split('\n');
    double w = 10, h = fm.height() * lines.size();
    for (const auto &l : lines) w = qMax(w, fm.horizontalAdvance(l));
    const int pad = style.outlineWidth + 8;
    return QSizeF(w + pad * 2, h + pad * 2);
}

QImage Compositor::renderText(const TextStyle &style, double scale) {
    QString key = style.text + "|" + style.family + "|" +
                  QString::number(style.pixelSize) + "|" +
                  QString::number(style.bold) + QString::number(style.italic) +
                  style.color.name(QColor::HexArgb) +
                  style.outlineColor.name(QColor::HexArgb) +
                  QString::number(style.outlineWidth) + "|" + QString::number(scale);
    auto it = m_textCache.find(key);
    if (it != m_textCache.end()) return it.value();

    QFont font(style.family);
    font.setPixelSize(qMax(4, int(style.pixelSize * scale)));
    font.setBold(style.bold);
    font.setItalic(style.italic);
    QFontMetricsF fm(font);
    const QStringList lines = style.text.split('\n');
    double w = 10, h = fm.height() * lines.size();
    for (const auto &l : lines) w = qMax(w, fm.horizontalAdvance(l));
    const int pad = int(style.outlineWidth * scale) + 8;
    QImage img(int(w) + pad * 2, int(h) + pad * 2,
               QImage::Format_ARGB32_Premultiplied);
    img.fill(Qt::transparent);
    QPainter p(&img);
    p.setRenderHint(QPainter::Antialiasing, true);
    QPainterPath path;
    double y = pad + fm.ascent();
    for (const auto &l : lines) {
        path.addText(pad + (w - fm.horizontalAdvance(l)) / 2.0, y, font, l);
        y += fm.height();
    }
    if (style.outlineWidth > 0) {
        QPen pen(style.outlineColor, style.outlineWidth * 2.0 * scale,
                 Qt::SolidLine, Qt::RoundCap, Qt::RoundJoin);
        p.strokePath(path, pen);
    }
    p.fillPath(path, style.color);
    p.end();
    if (m_textCache.size() > 32) m_textCache.clear();
    m_textCache.insert(key, img);
    return img;
}
