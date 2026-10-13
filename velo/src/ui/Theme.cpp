#include "ui/Theme.h"
#include <QHash>
#include <QPalette>
#include <QStyleFactory>

QIcon Theme::icon(const QString &name) {
    static QHash<QString, QIcon> cache;
    auto it = cache.find(name);
    if (it == cache.end())
        it = cache.insert(name, QIcon(QStringLiteral(":/icons/") + name +
                                      QStringLiteral(".svg")));
    return it.value();
}

void Theme::apply(QApplication &app) {
    app.setStyle(QStyleFactory::create("Fusion"));
    QPalette p;
    const QColor window(0xf4, 0xf5, 0xf7), base(0xff, 0xff, 0xff);
    const QColor text(0x1c, 0x20, 0x24), dim(0x8a, 0x92, 0x9b);
    p.setColor(QPalette::Window, window);
    p.setColor(QPalette::WindowText, text);
    p.setColor(QPalette::Base, base);
    p.setColor(QPalette::AlternateBase, window);
    p.setColor(QPalette::Text, text);
    p.setColor(QPalette::Button, window);
    p.setColor(QPalette::ButtonText, text);
    p.setColor(QPalette::BrightText, Qt::black);
    p.setColor(QPalette::Highlight, accent());
    p.setColor(QPalette::HighlightedText, Qt::white);
    p.setColor(QPalette::ToolTipBase, base);
    p.setColor(QPalette::ToolTipText, text);
    p.setColor(QPalette::PlaceholderText, dim);
    p.setColor(QPalette::Link, accent());
    p.setColor(QPalette::Disabled, QPalette::Text, dim);
    p.setColor(QPalette::Disabled, QPalette::ButtonText, dim);
    p.setColor(QPalette::Disabled, QPalette::WindowText, dim);
    app.setPalette(p);
    app.setStyleSheet(R"(
        QWidget { font-family: "Segoe UI Variable Text", "Segoe UI", "SF Pro Text", sans-serif; }
        QToolTip { background: #1c2024; color: #ffffff; border: 0; padding: 4px 7px; border-radius: 6px; }
        QSplitter::handle { background: #e4e6e9; }
        QDockWidget::title { background: #f7f8f9; padding: 6px 10px; border-bottom: 1px solid #e4e6e9; }
        QTabBar::tab { background: transparent; color: #555d66; padding: 6px 14px; border: 0; border-bottom: 2px solid transparent; }
        QTabBar::tab:selected { color: #1c2024; border-bottom: 2px solid #3f9a92; }
        QTabBar::tab:hover { color: #1c2024; }
        QMenuBar { background: #ffffff; border-bottom: 1px solid #e4e6e9; }
        QMenuBar::item { padding: 5px 10px; border-radius: 6px; }
        QMenuBar::item:selected { background: #eef0f2; }
        QMenu { background: #ffffff; border: 1px solid #e4e6e9; border-radius: 10px; padding: 5px; }
        QMenu::item { padding: 6px 22px 6px 12px; border-radius: 6px; }
        QMenu::item:selected { background: #e1f2ef; color: #23665f; }
        QPushButton, QToolButton { background: #ffffff; border: 1px solid #d3d7dc; border-radius: 8px; padding: 5px 12px; }
        QPushButton:hover, QToolButton:hover { background: #f7f8f9; }
        QPushButton:pressed, QToolButton:pressed { background: #eef0f2; }
        QPushButton:default { background: #3f9a92; color: #ffffff; border: 0; }
        QToolButton:checked { background: #e1f2ef; border-color: #b9e0da; color: #23665f; }
        QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: #ffffff; border: 1px solid #d3d7dc; border-radius: 8px; padding: 4px 8px; }
        QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus, QComboBox:focus { border-color: #3f9a92; }
        QSlider::groove:horizontal { height: 4px; background: #e4e6e9; border-radius: 2px; }
        QSlider::handle:horizontal { width: 14px; margin: -5px 0; border-radius: 7px; background: #ffffff; border: 1px solid #d3d7dc; }
        QSlider::sub-page:horizontal { background: #3f9a92; border-radius: 2px; }
        QScrollBar { background: transparent; }
        QScrollBar::handle { background: #d3d7dc; border-radius: 4px; min-width: 24px; min-height: 24px; }
        QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
        QListView, QTreeView { background: #ffffff; border: 1px solid #e4e6e9; border-radius: 10px; }
        QListView::item:selected, QTreeView::item:selected { background: #e1f2ef; color: #23665f; }
    )");
}
