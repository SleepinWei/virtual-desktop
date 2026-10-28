import { ensure } from '../../src/errors.js';

// Shared by native execution and the explicitly separate raster benchmark.
export async function browserAction(page, viewport, action) {
  if (action.type === 'click' || action.type === 'fill') {
    ensure(typeof action.selector === 'string' && action.selector.length <= 200, 400, 'INVALID_SELECTOR', 'A short CSS selector is required');
    if (action.type === 'fill') {
      ensure(typeof action.value === 'string' && action.value.length <= 2000, 400, 'INVALID_VALUE', 'Input is limited to 2000 characters');
      await page.locator(action.selector).fill(action.value, { timeout: 3000 });
    } else await page.locator(action.selector).click({ timeout: 3000 });
  } else if (action.type === 'pointer' || action.type === 'wheel') {
    ensure(Number.isFinite(action.x) && Number.isFinite(action.y) && action.x >= 0 && action.y >= 0 &&
      action.x < viewport.width && action.y < viewport.height, 400, 'INVALID_COORDINATES', 'Input must lie within the native viewport');
    if (action.type === 'pointer') await page.mouse.click(action.x, action.y);
    else {
      ensure(Number.isFinite(action.deltaY) && Math.abs(action.deltaY) <= 2000 &&
        Number.isFinite(action.deltaX ?? 0) && Math.abs(action.deltaX ?? 0) <= 2000, 400, 'INVALID_WHEEL', 'Wheel delta exceeds the local limit');
      await page.mouse.move(action.x, action.y); await page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
    }
  } else if (action.type === 'text') {
    ensure(typeof action.value === 'string' && action.value.length <= 2000, 400, 'INVALID_VALUE', 'Text is limited to 2000 characters');
    await page.keyboard.insertText(action.value);
  } else if (action.type === 'key') {
    const modifiers = action.modifiers || [];
    ensure(Array.isArray(modifiers) && modifiers.length <= 4 && new Set(modifiers).size === modifiers.length &&
      modifiers.every(item => ['Shift', 'Control', 'Alt', 'Meta'].includes(item)), 400, 'INVALID_KEY', 'Invalid key modifiers');
    ensure(['Enter', 'Tab', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Escape'].includes(action.key) ||
      /^[AZY]$/.test(action.key) && modifiers.some(item => ['Control', 'Meta'].includes(item)), 400, 'INVALID_KEY', 'Unsupported native key');
    await page.keyboard.press([...modifiers, action.key].join('+'));
  } else ensure(false, 400, 'UNSUPPORTED_ACTION', 'Unsupported native action');
}
