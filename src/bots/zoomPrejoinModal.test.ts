import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import {
  clickZoomJoinWithOptionalMediaPromptRetry,
  dismissZoomOptionalMediaPrompt,
  isZoomOptionalMediaPromptText,
} from './zoomPrejoinModal';

type PromptKind = 'see' | 'hear';

const promptTexts: Record<PromptKind, string> = {
  see: 'Do you want people to see you in the meeting? microphone and camera Continue without microphone and camera',
  hear: 'Do you want people to hear you in the meeting? microphone and camera Continue without microphone and camera',
};

const createPromptRoot = (
  initialPrompt?: PromptKind,
  transition?: { from: PromptKind; to: PromptKind },
) => {
  let activePrompt = initialPrompt;
  let buttonVisible = activePrompt !== undefined;
  const clicks: PromptKind[] = [];

  const locatorFor = (hasText: RegExp) => {
    const matches = () => activePrompt !== undefined && hasText.test(promptTexts[activePrompt]);
    const button = {
      first: () => button,
      click: async () => {
        if (!activePrompt || !buttonVisible || !matches()) throw new Error('button unavailable');
        const clicked = activePrompt;
        clicks.push(clicked);
        buttonVisible = false;
        activePrompt = transition?.from === clicked ? transition.to : undefined;
        buttonVisible = activePrompt !== undefined;
      },
      waitFor: async ({ state }: { state: 'visible' | 'hidden' }) => {
        const expected = state === 'visible' ? matches() && buttonVisible : !matches() || !buttonVisible;
        if (!expected) throw new Error('button state unavailable');
      },
    };
    const locator = {
      last: () => locator,
      waitFor: async ({ state }: { state: 'visible' | 'hidden' }) => {
        const expected = state === 'visible' ? matches() : !matches();
        if (!expected) throw new Error('prompt state unavailable');
      },
      innerText: async () => activePrompt && matches() ? promptTexts[activePrompt] : '',
      getByRole: () => button,
    };
    return locator;
  };

  return {
    root: {
      locator: () => ({ filter: ({ hasText }: { hasText: RegExp }) => locatorFor(hasText) }),
    } as unknown as Page,
    clicks,
    show: (prompt: PromptKind) => {
      activePrompt = prompt;
      buttonVisible = true;
    },
  };
};

test('recognizes supported Zoom optional media prompts', () => {
  assert.equal(isZoomOptionalMediaPromptText(
    'Do you want people to see you in the meeting?\nYou can still turn off your microphone and camera anytime.\nContinue without microphone and camera'
  ), true);
  assert.equal(isZoomOptionalMediaPromptText(
    'Vuoi che le persone ti sentano durante la riunione?\nPuoi disattivare microfono e videocamera in qualsiasi momento.\nContinua senza microfono e videocamera'
  ), true);
});

test('does not accept unrelated consent or CAPTCHA dialogs', () => {
  assert.equal(isZoomOptionalMediaPromptText('The host requires consent before joining. Continue'), false);
  assert.equal(isZoomOptionalMediaPromptText('Verify you are human. Complete the CAPTCHA.'), false);
});

test('dismisses the two sequential Zoom media prompts', async () => {
  const prompt = createPromptRoot('see', { from: 'see', to: 'hear' });
  const dismissed = await dismissZoomOptionalMediaPrompt(prompt.root);

  assert.equal(dismissed, true, `dismissed prompts: ${prompt.clicks.join(',')}`);
  assert.deepEqual(prompt.clicks, ['see', 'hear']);
});

test('retries Join only after a late optional media prompt is dismissed', async () => {
  const prompt = createPromptRoot();
  let attempts = 0;

  await clickZoomJoinWithOptionalMediaPromptRetry(prompt.root, async () => {
    attempts += 1;
    if (attempts === 1) {
      prompt.show('hear');
      throw new Error('overlay intercepted click');
    }
  });

  assert.equal(attempts, 2);
  assert.deepEqual(prompt.clicks, ['hear']);
});

test('dismisses a prompt opened after a successful Join click and retries', async () => {
  const prompt = createPromptRoot();
  let attempts = 0;

  await clickZoomJoinWithOptionalMediaPromptRetry(prompt.root, async () => {
    attempts += 1;
    if (attempts === 1) prompt.show('see');
  });

  assert.equal(attempts, 2);
  assert.deepEqual(prompt.clicks, ['see']);
});
