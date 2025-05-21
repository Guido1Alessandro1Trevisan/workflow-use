import * as rrweb from 'rrweb';
import { EventType, IncrementalSource } from '@rrweb/types';

let stopRecording: (() => void) | undefined = undefined;
let isRecordingActive = true; // Content script's local state
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let lastScrollY: number | null = null;
let lastDirection: 'up' | 'down' | null = null;
const DEBOUNCE_MS = 500; // Wait 500ms after scroll stops

// --- Helper function to generate XPath ---
function getXPath(element: HTMLElement): string {
  if (element.id !== '') {
    return `id("${element.id}")`;
  }
  if (element === document.body) {
    return element.tagName.toLowerCase();
  }

  let ix = 0;
  const siblings = element.parentNode?.children;
  if (siblings) {
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        return `${getXPath(
          element.parentElement as HTMLElement
        )}/${element.tagName.toLowerCase()}[${ix + 1}]`;
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
  }
  // Fallback (should not happen often)
  return element.tagName.toLowerCase();
}
// --- End Helper ---

// --- Helper function to generate CSS Selector ---
// Expanded set of safe attributes (similar to Python)
const SAFE_ATTRIBUTES = new Set([
  'id',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'role',
  'for',
  'autocomplete',
  'required',
  'readonly',
  'alt',
  'title',
  'src',
  'href',
  'target',
  // Add common data attributes if stable
  'data-id',
  'data-qa',
  'data-cy',
  'data-testid',
]);

function getEnhancedCSSSelector(element: HTMLElement, xpath: string): string {
  try {
    // Base selector from simplified XPath or just tagName
    let cssSelector = element.tagName.toLowerCase();

    // Handle class attributes
    if (element.classList && element.classList.length > 0) {
      const validClassPattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
      element.classList.forEach((className) => {
        if (className && validClassPattern.test(className)) {
          cssSelector += `.${CSS.escape(className)}`;
        }
      });
    }

    // Handle other safe attributes
    for (const attr of element.attributes) {
      const attrName = attr.name;
      const attrValue = attr.value;

      if (attrName === 'class') continue;
      if (!attrName.trim()) continue;
      if (!SAFE_ATTRIBUTES.has(attrName)) continue;

      const safeAttribute = CSS.escape(attrName);

      if (attrValue === '') {
        cssSelector += `[${safeAttribute}]`;
      } else {
        const safeValue = attrValue.replace(/"/g, '"');
        if (/["'<>`\s]/.test(attrValue)) {
          cssSelector += `[${safeAttribute}*="${safeValue}"]`;
        } else {
          cssSelector += `[${safeAttribute}="${safeValue}"]`;
        }
      }
    }
    return cssSelector;
  } catch (error) {
    console.error('Error generating enhanced CSS selector:', error);
    return `${element.tagName.toLowerCase()}[xpath="${xpath.replace(
      /"/g,
      '"'
    )}"]`;
  }
}

// --- Shadow DOM Helpers ---
function getComposedEventTarget(event: Event): HTMLElement | null {
  const path = event.composedPath ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof HTMLElement) return node;
  }
  return event.target instanceof HTMLElement ? event.target : null;
}

function buildShadowSelectorChain(element: HTMLElement): string[] {
  const chain: string[] = [];
  let node: HTMLElement | null = element;
  while (node) {
    const xpath = getXPath(node);
    chain.unshift(getEnhancedCSSSelector(node, xpath));
    const root = node.getRootNode();
    if (root instanceof ShadowRoot) {
      node = root.host as HTMLElement;
    } else {
      node = node.parentElement;
    }
  }
  return chain;
}

function instrumentShadowRoot(root: ShadowRoot) {
  root.addEventListener('click',  handleCustomClick  as EventListener, true);
  root.addEventListener('input',  handleInput        as EventListener, true);
  root.addEventListener('change', handleSelectChange as EventListener, true);
  root.addEventListener('keydown',handleKeydown      as EventListener, true);
  root.querySelectorAll('*').forEach(el => {
    const child = (el as HTMLElement).shadowRoot;
    if (child) instrumentShadowRoot(child);
  });
}

function scanExistingShadowRoots() {
  document.querySelectorAll('*').forEach((el) => {
    const sr = (el as HTMLElement).shadowRoot;
    if (sr) instrumentShadowRoot(sr);
  });
}

// --- NEW: scan closed roots via Chrome extension API (if available) -
function scanClosedShadowRootsExtension() {
  const api = (chrome as any).dom?.openOrClosedShadowRoot;
  if (!api) return;
  document.querySelectorAll('*').forEach((el) => {
    try {
      const sr = api(el);
      if (sr) instrumentShadowRoot(sr);
    } catch (_) {/* ignore */}
  });
}

// --- Monkey-patch attachShadow (already present) ---
const origAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function(init: ShadowRootInit): ShadowRoot {
  const shadow = origAttachShadow.call(this, init);
  try {
    instrumentShadowRoot(shadow);
  } catch (e) {
    console.error('Error instrumenting shadow root:', e);
  }
  return shadow;
};

// --- NEW: wrap customElements.define to catch constructor shadows ----
type HTMLElementCtor = new (...args: any[]) => HTMLElement;

// --- Wrap customElements.define to catch constructor shadows -------------
const origDefine = customElements.define.bind(customElements);
customElements.define = function (
  name: string,
  clazz: HTMLElementCtor,
  options?: ElementDefinitionOptions
) {
  const Wrapped = class extends clazz {
    constructor(...args: any[]) {
      super(...args);
      const sr = (this as any).shadowRoot as ShadowRoot | null;
      if (sr) instrumentShadowRoot(sr);
    }
  };

  // Cast so TS accepts it as a CustomElementConstructor
  return origDefine(name, Wrapped as unknown as CustomElementConstructor, options);
};

// --- NEW: MutationObserver safety net for late open roots -----------
const mo = new MutationObserver((records) => {
  records.forEach((rec) => {
    rec.addedNodes.forEach((n) => {
      if (n instanceof HTMLElement && n.shadowRoot) {
        instrumentShadowRoot(n.shadowRoot);
      }
    });
  });
});
mo.observe(document.documentElement, { childList: true, subtree: true });

function startRecorder() {
  if (stopRecording) {
    console.log('Recorder already running.');
    return; // Already running
  }
  console.log('Starting rrweb recorder for:', window.location.href);
  isRecordingActive = true;
  stopRecording = rrweb.record({
    emit(event) {
      if (!isRecordingActive) return;

      // Handle scroll events with debouncing and direction detection
      if (
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Scroll
      ) {
        const scrollData = event.data as { id: number; x: number; y: number };
        const currentScrollY = scrollData.y;

        // Round coordinates
        const roundedScrollData = {
          ...scrollData,
          x: Math.round(scrollData.x),
          y: Math.round(scrollData.y),
        };

        // Determine scroll direction
        let currentDirection: 'up' | 'down' | null = null;
        if (lastScrollY !== null) {
          currentDirection = currentScrollY > lastScrollY ? 'down' : 'up';
        }

        // Record immediately if direction changes
        if (
          lastDirection !== null &&
          currentDirection !== null &&
          currentDirection !== lastDirection
        ) {
          if (scrollTimeout) {
            clearTimeout(scrollTimeout);
            scrollTimeout = null;
          }
          chrome.runtime.sendMessage({
            type: 'RRWEB_EVENT',
            payload: {
              ...event,
              data: roundedScrollData, // Use rounded coordinates
            },
          });
          lastDirection = currentDirection;
          lastScrollY = currentScrollY;
          return;
        }

        // Update direction and position
        lastDirection = currentDirection;
        lastScrollY = currentScrollY;

        // Debouncer
        if (scrollTimeout) {
          clearTimeout(scrollTimeout);
        }
        scrollTimeout = setTimeout(() => {
          chrome.runtime.sendMessage({
            type: 'RRWEB_EVENT',
            payload: {
              ...event,
              data: roundedScrollData, // Use rounded coordinates
            },
          });
          scrollTimeout = null;
          lastDirection = null; // Reset direction for next scroll
        }, DEBOUNCE_MS);
      } else {
        // Pass through non-scroll events unchanged
        chrome.runtime.sendMessage({ type: 'RRWEB_EVENT', payload: event });
      }
    },
    maskInputOptions: {
      password: true,
    },
    checkoutEveryNms: 10000,
    checkoutEveryNth: 200,
  });

  // Add the stop function to window for potenti
  // --- End CSS Selector Helper --- al manual cleanup
  (window as any).rrwebStop = stopRecorder;

  // --- Attach Custom Event Listeners Permanently ---
  // These listeners are always active, but the handlers check `isRecordingActive`
  document.addEventListener('click', handleCustomClick, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleSelectChange, true);
  document.addEventListener('keydown', handleKeydown, true);
  console.log('Permanently attached custom event listeners.');
}

function stopRecorder() {
  if (stopRecording) {
    console.log('Stopping rrweb recorder for:', window.location.href);
    stopRecording();
    stopRecording = undefined;
    isRecordingActive = false;
    (window as any).rrwebStop = undefined; // Clean up window property
    // Remove custom listeners when recording stops
    document.removeEventListener('click', handleCustomClick, true);
    document.removeEventListener('input', handleInput, true);
    document.removeEventListener('change', handleSelectChange, true); // Remove change listener
    document.removeEventListener('keydown', handleKeydown, true); // Remove keydown listener
  } else {
    console.log('Recorder not running, cannot stop.');
  }
}

// --- Custom Click Handler ---
function handleCustomClick(event: MouseEvent) {
  if (!isRecordingActive) return;
  const targetElement = getComposedEventTarget(event);
  if (!targetElement) return;

  try {
    const xpath = getXPath(targetElement);
    const clickData = {
      timestamp: Date.now(),
      url: document.location.href, // Use document.location for main page URL
      frameUrl: window.location.href, // URL of the frame where the event occurred
      xpath: xpath,
      cssSelector: buildShadowSelectorChain(targetElement).join(' >> '),
      elementTag: targetElement.tagName,
      elementText: targetElement.textContent?.trim().slice(0, 200) || '',
    };
    console.log('Sending CUSTOM_CLICK_EVENT:', clickData);
    chrome.runtime.sendMessage({
      type: 'CUSTOM_CLICK_EVENT',
      payload: clickData,
    });
  } catch (error) {
    console.error('Error capturing click data:', error);
  }
}
// --- End Custom Click Handler ---

// --- Custom Input Handler ---
function handleInput(event: Event) {
  if (!isRecordingActive) return;
  const targetElement = getComposedEventTarget(event) as HTMLInputElement | HTMLTextAreaElement;
  if (!targetElement || !('value' in targetElement)) return;
  const isPassword = targetElement.type === 'password';

  try {
    const xpath = getXPath(targetElement);
    const inputData = {
      timestamp: Date.now(),
      url: document.location.href,
      frameUrl: window.location.href,
      xpath: xpath,
      cssSelector: buildShadowSelectorChain(targetElement).join(' >> '),
      elementTag: targetElement.tagName,
      value: isPassword ? '********' : targetElement.value,
    };
    console.log('Sending CUSTOM_INPUT_EVENT:', inputData);
    chrome.runtime.sendMessage({
      type: 'CUSTOM_INPUT_EVENT',
      payload: inputData,
    });
  } catch (error) {
    console.error('Error capturing input data:', error);
  }
}
// --- End Custom Input Handler ---

// --- Custom Select Change Handler ---
function handleSelectChange(event: Event) {
  if (!isRecordingActive) return;
  const targetElement = getComposedEventTarget(event) as HTMLSelectElement;
  // Ensure it's a select element
  if (!targetElement || targetElement.tagName !== 'SELECT') return;

  try {
    const xpath = getXPath(targetElement);
    const selectedOption = targetElement.options[targetElement.selectedIndex];
    const selectData = {
      timestamp: Date.now(),
      url: document.location.href,
      frameUrl: window.location.href,
      xpath: xpath,
      cssSelector: buildShadowSelectorChain(targetElement).join(' >> '),
      elementTag: targetElement.tagName,
      selectedValue: targetElement.value,
      selectedText: selectedOption ? selectedOption.text : '', // Get selected option text
    };
    console.log('Sending CUSTOM_SELECT_EVENT:', selectData);
    chrome.runtime.sendMessage({
      type: 'CUSTOM_SELECT_EVENT',
      payload: selectData,
    });
  } catch (error) {
    console.error('Error capturing select change data:', error);
  }
}
// --- End Custom Select Change Handler ---

// --- Custom Keydown Handler ---
// Set of keys we want to capture explicitly
const CAPTURED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Backspace',
  'Delete',
]);

function handleKeydown(event: KeyboardEvent) {
  if (!isRecordingActive) return;

  const key = event.key;
  let keyToLog = '';

  // Check if it's a key we explicitly capture
  if (CAPTURED_KEYS.has(key)) {
    keyToLog = key;
  }
  // Check for common modifier combinations (Ctrl/Cmd + key)
  else if (
    (event.ctrlKey || event.metaKey) &&
    key.length === 1 &&
    /[a-zA-Z0-9]/.test(key)
  ) {
    // Use 'CmdOrCtrl' to be cross-platform friendly in logs
    keyToLog = `CmdOrCtrl+${key.toUpperCase()}`;
  }
  // You could add more specific checks here (Alt+, Shift+, etc.) if needed

  // If we have a key we want to log, send the event
  if (keyToLog) {
    const targetElement = getComposedEventTarget(event) as HTMLElement;
    let xpath = '';
    let cssSelector = '';
    let elementTag = 'document'; // Default if target is not an element
    if (targetElement && typeof targetElement.tagName === 'string') {
      try {
        xpath = getXPath(targetElement);
        cssSelector = buildShadowSelectorChain(targetElement).join(' >> ');
        elementTag = targetElement.tagName;
      } catch (e) {
        console.error('Error getting selector for keydown target:', e);
      }
    }

    try {
      const keyData = {
        timestamp: Date.now(),
        url: document.location.href,
        frameUrl: window.location.href,
        key: keyToLog, // The key or combination pressed
        xpath: xpath, // XPath of the element in focus (if any)
        cssSelector: cssSelector, // CSS selector of the element in focus (if any)
        elementTag: elementTag, // Tag name of the element in focus
      };
      console.log('Sending CUSTOM_KEY_EVENT:', keyData);
      chrome.runtime.sendMessage({
        type: 'CUSTOM_KEY_EVENT',
        payload: keyData,
      });
    } catch (error) {
      console.error('Error capturing keydown data:', error);
    }
  }
}
// --- End Custom Keydown Handler ---

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main(ctx) {
    // NEW: Instrument shadow DOMs that already exist
    scanExistingShadowRoots();
    scanClosedShadowRootsExtension();

    // Listener for status updates from the background script
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'SET_RECORDING_STATUS') {
        const shouldBeRecording = message.payload;
        console.log(`Received recording status update: ${shouldBeRecording}`);
        if (shouldBeRecording && !isRecordingActive) {
          startRecorder();
        } else if (!shouldBeRecording && isRecordingActive) {
          stopRecorder();
        }
      }
      // If needed, handle other message types here
    });

    // Request initial status when the script loads
    console.log(
      'Content script loaded, requesting initial recording status...'
    );
    chrome.runtime.sendMessage(
      { type: 'REQUEST_RECORDING_STATUS' },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            'Error requesting initial status:',
            chrome.runtime.lastError.message
          );
          // Handle error - maybe default to not recording?
          return;
        }
        if (response && response.isRecordingEnabled) {
          console.log('Initial status: Recording enabled.');
          startRecorder();
        } else {
          console.log('Initial status: Recording disabled.');
          // Ensure recorder is stopped if it somehow started
          stopRecorder();
        }
      }
    );

    // Optional: Clean up recorder if the page is unloading
    window.addEventListener('beforeunload', () => {
      document.removeEventListener('click', handleCustomClick, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('change', handleSelectChange, true);
      document.removeEventListener('keydown', handleKeydown, true);
      stopRecorder(); // Ensure rrweb is stopped
    });
  },
});
