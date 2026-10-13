#include "effects/Effects.h"
#include <QtConcurrent>
#include <cmath>

// ------------------------------------------------------------- pixel helpers
namespace {

void forEachRow(QImage &img, const std::function<void(int)> &fn) {
    QVector<int> rows(img.height());
    std::iota(rows.begin(), rows.end(), 0);
    QtConcurrent::blockingMap(rows, fn);
}

// One horizontal+vertical box blur pass with the given radius (ARGB32).
void boxBlurPass(QImage &img, int radius) {
    if (radius < 1) return;
    const int w = img.width(), h = img.height();
    if (w < 2 || h < 2) return;
    QImage tmp(img.size(), img.format());
    const int div = radius * 2 + 1;
    // horizontal
    {
        QVector<int> rows(h);
        std::iota(rows.begin(), rows.end(), 0);
        QtConcurrent::blockingMap(rows, [&](int y) {
            const QRgb *src = reinterpret_cast<const QRgb *>(img.constScanLine(y));
            QRgb *dst = reinterpret_cast<QRgb *>(tmp.scanLine(y));
            int a = 0, r = 0, g = 0, b = 0;
            for (int x = -radius; x <= radius; ++x) {
                QRgb p = src[qBound(0, x, w - 1)];
                a += qAlpha(p); r += qRed(p); g += qGreen(p); b += qBlue(p);
            }
            for (int x = 0; x < w; ++x) {
                dst[x] = qRgba(r / div, g / div, b / div, a / div);
                QRgb pOut = src[qBound(0, x - radius, w - 1)];
                QRgb pIn = src[qBound(0, x + radius + 1, w - 1)];
                a += qAlpha(pIn) - qAlpha(pOut);
                r += qRed(pIn) - qRed(pOut);
                g += qGreen(pIn) - qGreen(pOut);
                b += qBlue(pIn) - qBlue(pOut);
            }
        });
    }
    // vertical
    {
        QVector<int> cols(w);
        std::iota(cols.begin(), cols.end(), 0);
        const qsizetype stride = tmp.bytesPerLine() / 4;
        const qsizetype strideO = img.bytesPerLine() / 4;
        const QRgb *base = reinterpret_cast<const QRgb *>(tmp.constBits());
        QRgb *out = reinterpret_cast<QRgb *>(img.bits());
        QtConcurrent::blockingMap(cols, [&](int x) {
            int a = 0, r = 0, g = 0, b = 0;
            for (int y = -radius; y <= radius; ++y) {
                QRgb p = base[qBound(0, y, h - 1) * stride + x];
                a += qAlpha(p); r += qRed(p); g += qGreen(p); b += qBlue(p);
            }
            for (int y = 0; y < h; ++y) {
                out[y * strideO + x] = qRgba(r / div, g / div, b / div, a / div);
                QRgb pOut = base[qBound(0, y - radius, h - 1) * stride + x];
                QRgb pIn = base[qBound(0, y + radius + 1, h - 1) * stride + x];
                a += qAlpha(pIn) - qAlpha(pOut);
                r += qRed(pIn) - qRed(pOut);
                g += qGreen(pIn) - qGreen(pOut);
                b += qBlue(pIn) - qBlue(pOut);
            }
        });
    }
}

void gaussianBlur(QImage &img, double radius) {
    // 3 box passes approximate a gaussian
    int r = qMax(1, int(radius / 2));
    boxBlurPass(img, r);
    boxBlurPass(img, r);
    boxBlurPass(img, qMax(1, int(radius - 2 * r)));
}

void colorCorrect(QImage &img, double brightness, double contrast,
                  double saturation, double temperature) {
    // brightness -100..100, contrast -100..100, saturation 0..200, temp -100..100
    uchar lut[256], lutR[256], lutB[256];
    const double b = brightness * 1.275;            // -127..127
    const double c = (contrast + 100.0) / 100.0;    // 0..2
    const double t = temperature * 0.45;
    for (int i = 0; i < 256; ++i) {
        double v = (i - 127.5) * c + 127.5 + b;
        lut[i] = uchar(qBound(0.0, v, 255.0));
        lutR[i] = uchar(qBound(0.0, v + t, 255.0));
        lutB[i] = uchar(qBound(0.0, v - t, 255.0));
    }
    const double sat = saturation / 100.0;
    const bool doSat = std::abs(sat - 1.0) > 1e-3;
    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        const int w = img.width();
        for (int x = 0; x < w; ++x) {
            int r = lutR[qRed(px[x])], g = lut[qGreen(px[x])], bl = lutB[qBlue(px[x])];
            if (doSat) {
                int luma = (r * 54 + g * 183 + bl * 19) >> 8;
                r = qBound(0, int(luma + (r - luma) * sat), 255);
                g = qBound(0, int(luma + (g - luma) * sat), 255);
                bl = qBound(0, int(luma + (bl - luma) * sat), 255);
            }
            px[x] = qRgba(r, g, bl, qAlpha(px[x]));
        }
    });
}

// Full color grade. Tonal chain (white balance, exposure, lift/gamma/gain,
// contrast, whites/blacks) is monotone per channel -> baked into one 256-entry
// float LUT per channel. Highlights/shadows are luma-masked gains (a second
// LUT on luma), hue/saturation/vibrance work per pixel on the chroma vector.
void colorGrade(QImage &img, const QMap<QString, double> &p) {
    const double exposure = p.value("exposure");           // stops
    const double contrast = p.value("contrast");           // -100..100
    const double highlights = p.value("highlights") / 100; // -1..1
    const double shadows = p.value("shadows") / 100;
    const double whites = p.value("whites") / 100;
    const double blacks = p.value("blacks") / 100;
    const double temp = p.value("temperature") / 100;
    const double tint = p.value("tint") / 100;
    const double hue = p.value("hue");                     // degrees
    const double sat = p.value("saturation", 100) / 100;
    const double vib = p.value("vibrance") / 100;
    const double lift = p.value("lift") / 100;
    const double gamma = p.value("gamma") / 100;
    const double gain = p.value("gain") / 100;

    // per-channel tonal LUT
    const double wbR = 1.0 + 0.30 * temp + 0.10 * tint;
    const double wbG = 1.0 - 0.20 * tint;
    const double wbB = 1.0 - 0.30 * temp + 0.10 * tint;
    const double exp2v = std::pow(2.0, exposure);
    const double gainK = 1.0 + gain;            // ±100% -> 0..2x
    const double liftK = lift * 0.25;           // shadows offset, ±0.25
    const double gammaExp = std::pow(2.0, -gamma);  // ±1 stop on the mids
    const double ck = (contrast + 100.0) / 100.0;   // pivot contrast 0..2
    const double pivot = 0.435;                 // ~18% grey in sRGB
    const double bp = -blacks * 0.25, wp = 1.0 + whites * -0.25;
    float lutR[256], lutG[256], lutB[256];
    auto tone = [&](double v, double wb) {
        v *= wb * exp2v * gainK;
        v += liftK * (1.0 - v);
        v = std::pow(qMax(v, 0.0), gammaExp);
        v = (v - pivot) * ck + pivot;
        v = (v - bp) / qMax(0.05, wp - bp);
        return float(qBound(0.0, v, 1.0));
    };
    for (int i = 0; i < 256; ++i) {
        const double v = i / 255.0;
        lutR[i] = tone(v, wbR);
        lutG[i] = tone(v, wbG);
        lutB[i] = tone(v, wbB);
    }

    // luma-masked highlight/shadow gain, indexed by luma byte
    float lumaGain[256];
    const bool doHS = std::abs(highlights) > 1e-3 || std::abs(shadows) > 1e-3;
    for (int i = 0; i < 256; ++i) {
        const double l = i / 255.0;
        const double target = l + 0.35 * shadows * (1 - l) * (1 - l) +
                              0.35 * highlights * l * l;
        lumaGain[i] = float(qBound(0.0, target, 1.0) / qMax(l, 1e-3));
    }

    // hue rotation about the neutral (grey) axis of RGB space
    const bool doHue = std::abs(hue) > 0.05;
    const double a = hue * M_PI / 180.0, cosA = std::cos(a), sinA = std::sin(a);
    const double hm00 = cosA + (1 - cosA) / 3, hmA = (1 - cosA) / 3 - sinA / std::sqrt(3.0),
                 hmB = (1 - cosA) / 3 + sinA / std::sqrt(3.0);
    const bool doSat = std::abs(sat - 1.0) > 1e-3 || std::abs(vib) > 1e-3;

    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        const int w = img.width();
        for (int x = 0; x < w; ++x) {
            float r = lutR[qRed(px[x])], g = lutG[qGreen(px[x])],
                  b = lutB[qBlue(px[x])];
            float l = 0.2126f * r + 0.7152f * g + 0.0722f * b;
            if (doHS) {
                const float f = lumaGain[int(l * 255.0f + 0.5f)];
                r *= f; g *= f; b *= f;
            }
            if (doHue) {
                const float r2 = float(hm00 * r + hmA * g + hmB * b);
                const float g2 = float(hmB * r + hm00 * g + hmA * b);
                const float b2 = float(hmA * r + hmB * g + hm00 * b);
                r = r2; g = g2; b = b2;
            }
            if (doSat) {
                l = 0.2126f * r + 0.7152f * g + 0.0722f * b;
                float cr = r - l, cg = g - l, cb = b - l;
                // vibrance: boost muted colors more than saturated ones
                const float cmag = qMin(
                    1.0f, 3.0f * qMax(qMax(std::abs(cr), std::abs(cg)),
                                      std::abs(cb)));
                const float k = float(sat * (1.0 + vib * (1.0 - cmag)));
                r = l + cr * k; g = l + cg * k; b = l + cb * k;
            }
            px[x] = qRgba(qBound(0, int(r * 255.0f + 0.5f), 255),
                          qBound(0, int(g * 255.0f + 0.5f), 255),
                          qBound(0, int(b * 255.0f + 0.5f), 255),
                          qAlpha(px[x]));
        }
    });
}

void sharpen(QImage &img, double amount) {
    if (amount <= 0) return;
    QImage blurred = img.copy();
    boxBlurPass(blurred, 1);
    const double k = amount / 100.0 * 1.5;
    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        const QRgb *bl = reinterpret_cast<const QRgb *>(blurred.constScanLine(y));
        const int w = img.width();
        for (int x = 0; x < w; ++x) {
            int r = qBound(0, int(qRed(px[x]) + (qRed(px[x]) - qRed(bl[x])) * k), 255);
            int g = qBound(0, int(qGreen(px[x]) + (qGreen(px[x]) - qGreen(bl[x])) * k), 255);
            int b = qBound(0, int(qBlue(px[x]) + (qBlue(px[x]) - qBlue(bl[x])) * k), 255);
            px[x] = qRgba(r, g, b, qAlpha(px[x]));
        }
    });
}

void vignette(QImage &img, double amount) {
    if (amount <= 0) return;
    const double cx = img.width() / 2.0, cy = img.height() / 2.0;
    const double maxD = std::sqrt(cx * cx + cy * cy);
    const double k = amount / 100.0;
    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        const int w = img.width();
        for (int x = 0; x < w; ++x) {
            double d = std::sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxD;
            double f = 1.0 - k * d * d * 1.4;
            f = qBound(0.0, f, 1.0);
            px[x] = qRgba(int(qRed(px[x]) * f), int(qGreen(px[x]) * f),
                          int(qBlue(px[x]) * f), qAlpha(px[x]));
        }
    });
}

void cropEdges(QImage &img, double l, double r, double t, double b) {
    const int w = img.width(), h = img.height();
    const int x0 = qBound(0, int(w * l / 100.0), w);
    const int x1 = qBound(0, w - int(w * r / 100.0), w);
    const int y0 = qBound(0, int(h * t / 100.0), h);
    const int y1 = qBound(0, h - int(h * b / 100.0), h);
    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        if (y < y0 || y >= y1) {
            std::fill(px, px + w, qRgba(0, 0, 0, 0));
            return;
        }
        std::fill(px, px + x0, qRgba(0, 0, 0, 0));
        std::fill(px + qMax(x0, x1), px + w, qRgba(0, 0, 0, 0));
    });
}

void blackWhite(QImage &img, double mix) {
    const double m = qBound(0.0, mix / 100.0, 1.0);
    forEachRow(img, [&](int y) {
        QRgb *px = reinterpret_cast<QRgb *>(img.scanLine(y));
        const int w = img.width();
        for (int x = 0; x < w; ++x) {
            int luma = (qRed(px[x]) * 54 + qGreen(px[x]) * 183 + qBlue(px[x]) * 19) >> 8;
            int r = int(qRed(px[x]) * (1 - m) + luma * m);
            int g = int(qGreen(px[x]) * (1 - m) + luma * m);
            int b = int(qBlue(px[x]) * (1 - m) + luma * m);
            px[x] = qRgba(r, g, b, qAlpha(px[x]));
        }
    });
}

}  // namespace

// ------------------------------------------------------------ EffectRegistry
EffectRegistry *EffectRegistry::instance() {
    static EffectRegistry r;
    return &r;
}

EffectInstance EffectRegistry::createInstance(const QString &id) const {
    EffectInstance inst;
    inst.effectId = id;
    if (const EffectDesc *d = byId(id))
        for (const auto &p : d->params)
            inst.params[p.id] = AnimatedParam(p.def);
    return inst;
}

EffectRegistry::EffectRegistry() {
    // ---- video effects -----------------------------------------------------
    registerEffect({
        "gaussian_blur", "Gaussian Blur", "Blur",
        {{"radius", "Radius", 0, 200, 10, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double scale) {
            double r = p.value("radius") * scale;
            if (r >= 0.5) gaussianBlur(img, r);
        }});
    registerEffect({
        "color_correction", "Color Correction", "Color",
        {{"brightness", "Brightness", -100, 100, 0, 1, 0},
         {"contrast", "Contrast", -100, 100, 0, 1, 0},
         {"saturation", "Saturation", 0, 200, 100, 1, 0},
         {"temperature", "Temperature", -100, 100, 0, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            colorCorrect(img, p.value("brightness"), p.value("contrast"),
                         p.value("saturation", 100), p.value("temperature"));
        }});
    registerEffect({
        "color_grade", "Color Grade", "Color",
        {{"exposure", "Exposure (EV)", -4, 4, 0, 0.05, 2},
         {"contrast", "Contrast", -100, 100, 0, 1, 0},
         {"highlights", "Highlights", -100, 100, 0, 1, 0},
         {"shadows", "Shadows", -100, 100, 0, 1, 0},
         {"whites", "Whites", -100, 100, 0, 1, 0},
         {"blacks", "Blacks", -100, 100, 0, 1, 0},
         {"temperature", "Temperature", -100, 100, 0, 1, 0},
         {"tint", "Tint", -100, 100, 0, 1, 0},
         {"hue", "Hue", -180, 180, 0, 1, 0},
         {"saturation", "Saturation", 0, 200, 100, 1, 0},
         {"vibrance", "Vibrance", -100, 100, 0, 1, 0},
         {"lift", "Lift", -100, 100, 0, 1, 0},
         {"gamma", "Gamma", -100, 100, 0, 1, 0},
         {"gain", "Gain", -100, 100, 0, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            colorGrade(img, p);
        }});
    registerEffect({
        "sharpen", "Sharpen", "Color",
        {{"amount", "Amount", 0, 300, 50, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            sharpen(img, p.value("amount"));
        }});
    registerEffect({
        "black_white", "Black & White", "Color",
        {{"mix", "Mix", 0, 100, 100, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            blackWhite(img, p.value("mix", 100));
        }});
    registerEffect({
        "crop", "Crop", "Transform",
        {{"left", "Left %", 0, 100, 0, 1, 1},
         {"right", "Right %", 0, 100, 0, 1, 1},
         {"top", "Top %", 0, 100, 0, 1, 1},
         {"bottom", "Bottom %", 0, 100, 0, 1, 1}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            if (p.value("left") + p.value("right") + p.value("top") +
                    p.value("bottom") > 0.01)
                cropEdges(img, p.value("left"), p.value("right"),
                          p.value("top"), p.value("bottom"));
        }});
    registerEffect({
        "vignette", "Vignette", "Stylize",
        {{"amount", "Amount", 0, 100, 40, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            vignette(img, p.value("amount"));
        }});
    registerEffect({
        "flip", "Flip", "Stylize",
        {{"horizontal", "Horizontal", 0, 1, 1, 1, 0},
         {"vertical", "Vertical", 0, 1, 0, 1, 0}},
        [](QImage &img, const QMap<QString, double> &p, double) {
            bool h = p.value("horizontal", 1) > 0.5, v = p.value("vertical") > 0.5;
            if (h || v) {
#if QT_VERSION >= QT_VERSION_CHECK(6, 9, 0)
                img = img.flipped((h ? Qt::Horizontal : Qt::Orientations()) |
                                          (v ? Qt::Vertical : Qt::Orientations()));
#else
                img = img.mirrored(h, v);  // Qt < 6.9 compatibility
#endif
            }
        }});

    // ---- audio effects -----------------------------------------------------
    {
        EffectDesc gain{"gain", "Gain", "Audio",
                        {{"db", "Gain (dB)", -48, 24, 0, 0.5, 1}},
                        nullptr};
        gain.isAudio = true;
        registerEffect(gain);
    }

    // ---- transitions (dragged onto clip edges) ------------------------------
    auto trans = [this](const QString &id, const QString &name, TransitionType t) {
        EffectDesc d{id, name, "Transitions", {}, nullptr};
        d.isTransition = true;
        d.transitionType = t;
        registerEffect(d);
    };
    trans("t_dissolve", "Cross Dissolve", TransitionType::CrossDissolve);
    trans("t_fade", "Fade (in/out)", TransitionType::Fade);
    trans("t_dip_black", "Dip to Black", TransitionType::DipToBlack);
}

double audioEffectGain(const Clip &clip, double localT) {
    double db = 0;
    for (const auto &e : clip.effects) {
        if (!e.enabled) continue;
        const EffectDesc *d = EffectRegistry::instance()->byId(e.effectId);
        if (d && d->isAudio && e.effectId == "gain")
            db += e.params.value("db").at(localT);
    }
    return std::pow(10.0, db / 20.0);
}
