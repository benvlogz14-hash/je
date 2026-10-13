#pragma once
#include "core/Document.h"
#include <QPointer>
#include <QWidget>
#include <functional>

class QDoubleSpinBox;
class QLabel;
class QToolButton;
class QVBoxLayout;

// One keyframable numeric parameter: spinbox + animation (stopwatch) toggle
// + add/remove keyframe diamond. Resolves its AnimatedParam afresh on every
// access so model edits/undo can never leave it dangling.
class ParamRow : public QWidget {
    Q_OBJECT
public:
    using Resolver = std::function<AnimatedParam *()>;
    using TimeFn = std::function<double()>;
    ParamRow(Document *doc, const QString &seqId, const QString &label,
             Resolver resolve, TimeFn localTime, double min, double max,
             double step, int decimals, QWidget *parent = nullptr);
    void refresh();  // re-read the value at the current time
    void setExtraWidget(QWidget *w);

signals:
    void valueEdited();

private:
    void maybeUndoStep();
    Document *m_doc;
    QString m_seqId;
    Resolver m_resolve;
    TimeFn m_localTime;
    QDoubleSpinBox *m_spin;
    QToolButton *m_animBtn, *m_keyBtn;
    qint64 m_lastEditMs = 0;
    bool m_updating = false;
};

// Effect Controls: transform/text/volume/effect parameters of the selected
// clip, or volume of the selected track. Everything is keyframable.
class PropertiesPanel : public QWidget {
    Q_OBJECT
public:
    explicit PropertiesPanel(Document *doc, QWidget *parent = nullptr);

private:
    void rebuild();
    void refreshValues();
    void buildClipUi(QVBoxLayout *lay, quint64 clipId);
    void buildTrackUi(QVBoxLayout *lay);
    ParamRow *addRow(QVBoxLayout *lay, const QString &label,
                     ParamRow::Resolver resolve, ParamRow::TimeFn timeFn,
                     double min, double max, double step = 0.01,
                     int decimals = 2);
    QWidget *groupBox(QVBoxLayout *parent, const QString &title);

    Document *m_doc;
    QWidget *m_content = nullptr;
    class QScrollArea *m_scroll = nullptr;
    class QPlainTextEdit *m_textEdit = nullptr;  // set while a text clip shows
    QList<ParamRow *> m_rows;
    quint64 m_clipId = 0;
    bool m_selfEdit = false;
};
