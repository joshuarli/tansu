import { setupDOM, assertEqual, assert, mockFetch } from './test-helper.ts';
const cleanup = setupDOM();
const mock = mockFetch();

mock.on('GET', '/api/settings', {
  weight_title: 10, weight_headings: 5, weight_tags: 2, weight_content: 1,
  fuzzy_distance: 1, result_limit: 20, show_score_breakdown: true, excluded_folders: ['archive'],
});
mock.on('PUT', '/api/settings', {});

const { createSettings } = await import('./settings.ts');
const { toggle: toggleSettings, open: openSettings, close: closeSettings, isOpen: isSettingsOpen } = createSettings();

// Initially closed
assertEqual(isSettingsOpen(), false, 'initially closed');

// Open
await openSettings();
assertEqual(isSettingsOpen(), true, 'opened');
const overlay = document.getElementById('settings-overlay')!;
assert(!overlay.classList.contains('hidden'), 'overlay visible');

// Panel rendered with form elements
const panel = document.getElementById('settings-panel')!;
assert(panel.querySelector('h2') !== null, 'settings heading');
assert(panel.innerHTML.includes('Title'), 'has Title weight label');
assert(panel.innerHTML.includes('Fuzzy distance'), 'has fuzzy distance');

// Slider values populated
const titleSlider = panel.querySelector('input[data-key="weight_title"]') as HTMLInputElement;
assert(titleSlider !== null, 'title slider exists');
assertEqual(titleSlider.value, '10', 'title slider value');

// Checkbox populated
const scoreCheckbox = panel.querySelector('input[data-key="show_score_breakdown"]') as HTMLInputElement;
assert(scoreCheckbox !== null, 'score checkbox exists');
assertEqual(scoreCheckbox.checked, true, 'score checkbox checked');

// Excluded folders populated
const excludedInput = panel.querySelector('input[data-key="excluded_folders"]') as HTMLInputElement;
assert(excludedInput !== null, 'excluded folders input');
assertEqual(excludedInput.value, 'archive', 'excluded folders value');

// Close
closeSettings();
assertEqual(isSettingsOpen(), false, 'closed');
assert(overlay.classList.contains('hidden'), 'overlay hidden');

// Toggle
toggleSettings();
// toggleSettings calls openSettings which is async, give it a tick
await new Promise(r => setTimeout(r, 10));
assertEqual(isSettingsOpen(), true, 'toggle opens');
toggleSettings();
assertEqual(isSettingsOpen(), false, 'toggle closes');

// Overlay click closes
await openSettings();
overlay.click();
assertEqual(isSettingsOpen(), false, 'overlay click closes');

mock.restore();
cleanup();
console.log('All settings tests passed');
