import Yoga from 'yoga-layout';
import { PROTOCOL_VERSION } from './protocol.js';

const numeric = (value, fallback = 0) => Number.parseFloat(value) || fallback;
const round = value => Math.round(value * 100) / 100;
const directions = { row: Yoga.FLEX_DIRECTION_ROW, column: Yoga.FLEX_DIRECTION_COLUMN };
const aligns = { center: Yoga.ALIGN_CENTER, stretch: Yoga.ALIGN_STRETCH, 'flex-start': Yoga.ALIGN_FLEX_START, 'flex-end': Yoga.ALIGN_FLEX_END };
const justifies = { center: Yoga.JUSTIFY_CENTER, 'space-between': Yoga.JUSTIFY_SPACE_BETWEEN, 'flex-end': Yoga.JUSTIFY_FLEX_END };

export class LayoutEngine {
  ids = new WeakMap();
  nextId = 0;
  constructor(document) { this.document = document; }
  id(element) {
    if (!this.ids.has(element)) this.ids.set(element, `n${++this.nextId}`);
    return this.ids.get(element);
  }

  scene(viewport, seq) {
    const records = [];
    const build = (element, inherited = {}) => {
      const style = element.style;
      const tag = element.localName;
      const node = Yoga.Node.create();
      const fontSize = numeric(style.fontSize, tag === 'h1' ? 24 : tag === 'h2' ? 18 : inherited.fontSize || 14);
      const color = style.color || inherited.color || '#24344e';
      const text = tag === 'input' ? element.value || element.getAttribute('placeholder') || '' : element.children.length === 0 ? element.textContent : '';
      const record = { element, node, tag, fontSize, color, text, id: this.id(element) };
      records.push(record);
      node.setFlexDirection(directions[style.flexDirection] ?? Yoga.FLEX_DIRECTION_COLUMN);
      node.setFlexShrink(0);
      if (style.display === 'none' || element.hasAttribute('hidden')) node.setDisplay(Yoga.DISPLAY_NONE);
      for (const [property, setter] of [['width', 'setWidth'], ['height', 'setHeight'], ['minWidth', 'setMinWidth'], ['maxWidth', 'setMaxWidth'], ['minHeight', 'setMinHeight']]) {
        if (style[property]) node[setter](style[property].endsWith('%') ? style[property] : numeric(style[property]));
      }
      if (style.flexGrow) node.setFlexGrow(numeric(style.flexGrow));
      if (style.flexShrink) node.setFlexShrink(numeric(style.flexShrink));
      node.setPadding(Yoga.EDGE_ALL, numeric(style.padding, ['button', 'input'].includes(tag) ? 10 : 0));
      for (const [suffix, edge] of [['Top', Yoga.EDGE_TOP], ['Right', Yoga.EDGE_RIGHT], ['Bottom', Yoga.EDGE_BOTTOM], ['Left', Yoga.EDGE_LEFT]]) {
        if (style[`padding${suffix}`]) node.setPadding(edge, numeric(style[`padding${suffix}`]));
        if (style[`margin${suffix}`]) node.setMargin(edge, numeric(style[`margin${suffix}`]));
      }
      if (style.margin) node.setMargin(Yoga.EDGE_ALL, numeric(style.margin));
      if (style.gap) node.setGap(Yoga.GUTTER_ALL, numeric(style.gap));
      if (style.alignItems) node.setAlignItems(aligns[style.alignItems] ?? Yoga.ALIGN_STRETCH);
      if (style.justifyContent) node.setJustifyContent(justifies[style.justifyContent] ?? Yoga.JUSTIFY_FLEX_START);
      if (text || ['input', 'button'].includes(tag)) {
        if (!element.children.length) node.setMeasureFunc((available, mode) => ({
          width: mode === Yoga.MEASURE_MODE_EXACTLY ? available : Math.min(mode === Yoga.MEASURE_MODE_AT_MOST ? available : Infinity, text.length * fontSize * .59),
          height: fontSize * 1.5,
        }));
        if (!style.height) node.setHeight(fontSize * 1.5 + (['input', 'button'].includes(tag) ? 20 : 0));
        // Deliberately approximate text measurement; no glyph rasterization here.
        if (!style.width && ['input', 'button', 'span'].includes(tag)) node.setMinWidth(Math.min(700, text.length * fontSize * 0.59 + (tag === 'span' ? 0 : 20)));
        if (tag === 'input') { node.setMinWidth(0); node.setFlexShrink(1); if (style.flexGrow) node.setFlexBasis(0); }
      }
      for (const child of element.children) {
        if (['script', 'style', 'head'].includes(child.localName)) continue;
        node.insertChild(build(child, { fontSize, color }), node.getChildCount());
      }
      return node;
    };
    const rootElement = this.document.querySelector('#app');
    const root = build(rootElement);
    root.setWidth(viewport.width);
    root.calculateLayout(viewport.width, undefined, Yoga.DIRECTION_LTR);
    const boxes = new Map();
    for (const record of records) {
      const layout = record.node.getComputedLayout();
      const parent = boxes.get(record.element.parentElement);
      boxes.set(record.element, {
        x: round(layout.left + (parent?.x || 0)), y: round(layout.top + (parent?.y || 0)),
        width: round(layout.width), height: round(layout.height),
      });
    }
    const commands = [], targets = [];
    for (const { element, tag, text, id, fontSize, color } of records) {
      const box = boxes.get(element), style = element.style;
      if (!box.width || !box.height || style.display === 'none') continue;
      const isControl = ['button', 'input'].includes(tag);
      const background = style.backgroundColor || (tag === 'button' ? '#e9eef6' : tag === 'input' ? '#ffffff' : null);
      if (background || isControl || style.borderWidth) commands.push({
        id: `${id}:box`, op: 'rect', ...box,
        fill: background || 'transparent', stroke: style.borderColor || (isControl ? '#cbd6e5' : 'transparent'),
        strokeWidth: numeric(style.borderWidth, isControl ? 1 : 0), radius: numeric(style.borderRadius, isControl ? 7 : 0),
      });
      if (text) {
        const padding = numeric(style.padding, isControl ? 10 : 0);
        commands.push({ id: `${id}:text`, op: 'text', x: box.x + padding, y: box.y + box.height / 2,
          width: Math.max(1, box.width - padding * 2), height: box.height,
          text, fontSize, fill: tag === 'input' && !element.value ? '#8190a5' : color });
      }
      if (element.hasAttribute('data-chart')) commands.push({ id: `${id}:path`, op: 'path', stroke: '#2463eb', strokeWidth: 3,
        points: [0, 0.22, 0.12, 0.32, 0.25, 0.25, 0.42, 0.62, 0.57, 0.46, 0.75, 0.78, 1, 0.92].reduce((points, value, index, all) => {
          if (index % 2 === 0) points.push([round(box.x + 16 + value * (box.width - 32)), round(box.y + box.height - 12 - all[index + 1] * (box.height - 24))]);
          return points;
        }, []) });
      if (isControl) targets.push({ id, selector: `#${element.id}`, tag, label: element.getAttribute('aria-label') || text,
        ...(tag === 'input' ? { value: element.value } : {}), ...box });
    }
    const contentHeight = Math.max(viewport.height, round(root.getComputedHeight()));
    root.freeRecursive();
    return { version: PROTOCOL_VERSION, seq, viewport: { ...viewport, contentHeight }, commands, targets };
  }
}
