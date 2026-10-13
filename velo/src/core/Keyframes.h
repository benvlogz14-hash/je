#pragma once
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <cmath>

// A scalar parameter that can be animated with keyframes.
// Keyframe times are local to the owner (clip-local seconds, or
// sequence-global seconds for track-level parameters).
class AnimatedParam {
public:
    AnimatedParam() = default;
    explicit AnimatedParam(double v) : m_base(v) {}

    bool animated() const { return !m_keys.isEmpty(); }
    double base() const { return m_base; }
    void setBase(double v) { m_base = v; }

    double at(double t) const {
        if (m_keys.isEmpty())
            return m_base;
        auto it = m_keys.lowerBound(t);
        if (it == m_keys.begin())
            return it.value();
        if (it == m_keys.end())
            return std::prev(it).value();
        auto prev = std::prev(it);
        double span = it.key() - prev.key();
        if (span <= 1e-9)
            return it.value();
        double f = (t - prev.key()) / span;
        // smoothstep easing keeps motion pleasant without bezier UI
        f = f * f * (3.0 - 2.0 * f);
        return prev.value() + (it.value() - prev.value()) * f;
    }

    // Set the effective value at time t: moves/creates a keyframe if
    // animated, otherwise changes the base value.
    void setAt(double t, double v) {
        if (animated())
            setKey(t, v);
        else
            m_base = v;
    }

    void setKey(double t, double v) { m_keys.insert(quantize(t), v); }
    void removeKey(double t) { m_keys.remove(quantize(t)); }
    bool hasKeyAt(double t) const { return m_keys.contains(quantize(t)); }
    void clearKeys() { m_keys.clear(); }
    const QMap<double, double> &keys() const { return m_keys; }
    QMap<double, double> &keysRef() { return m_keys; }

    QJsonObject toJson() const {
        QJsonObject o;
        o["base"] = m_base;
        if (!m_keys.isEmpty()) {
            QJsonArray arr;
            for (auto it = m_keys.begin(); it != m_keys.end(); ++it) {
                QJsonArray k{it.key(), it.value()};
                arr.append(k);
            }
            o["keys"] = arr;
        }
        return o;
    }
    static AnimatedParam fromJson(const QJsonObject &o, double fallback = 0.0) {
        AnimatedParam p(o.contains("base") ? o["base"].toDouble() : fallback);
        for (const auto &kv : o["keys"].toArray()) {
            QJsonArray k = kv.toArray();
            p.m_keys.insert(k[0].toDouble(), k[1].toDouble());
        }
        return p;
    }

private:
    static double quantize(double t) { return std::round(t * 1000.0) / 1000.0; }
    double m_base = 0.0;
    QMap<double, double> m_keys;
};
