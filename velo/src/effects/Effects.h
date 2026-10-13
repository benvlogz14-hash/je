#pragma once
#include "core/Model.h"
#include <QImage>
#include <QString>
#include <functional>

// ---------------------------------------------------------------------------
// Modular effect system. To add a new effect, append one registerEffect()
// call in Effects.cpp — UI, serialization and keyframing pick it up
// automatically.
// ---------------------------------------------------------------------------

struct EffectParamDesc {
    QString id;
    QString name;
    double min = 0, max = 1, def = 0, step = 0.01;
    int decimals = 2;
};

struct EffectDesc {
    QString id;
    QString name;
    QString category;  // "Blur", "Color", "Stylize", "Audio", "Transitions"
    QList<EffectParamDesc> params;
    // Video effects mutate the clip's frame in place. `scale` is the preview
    // render scale (1.0 = full res) so pixel-sized params can compensate.
    std::function<void(QImage &, const QMap<QString, double> &, double scale)> apply;
    bool isTransition = false;
    TransitionType transitionType = TransitionType::None;
    bool isAudio = false;

    const EffectParamDesc *param(const QString &pid) const {
        for (const auto &p : params)
            if (p.id == pid) return &p;
        return nullptr;
    }
};

class EffectRegistry {
public:
    static EffectRegistry *instance();
    void registerEffect(const EffectDesc &d) { m_effects.append(d); }
    const QList<EffectDesc> &effects() const { return m_effects; }
    const EffectDesc *byId(const QString &id) const {
        for (const auto &e : m_effects)
            if (e.id == id) return &e;
        return nullptr;
    }
    // Create an instance with default (keyframable) parameter values.
    EffectInstance createInstance(const QString &id) const;

private:
    EffectRegistry();
    QList<EffectDesc> m_effects;
};

// Audio gain in dB for a clip at clip-local time, from audio effects.
double audioEffectGain(const Clip &clip, double localT);
