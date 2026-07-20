import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { ZoomGuestJoinBlockedError } from '../error';
import {
  classifyZoomPostJoinBlock,
  clickZoomJoinWithOptionalMediaPromptRetry,
  detectZoomPostJoinBlock,
  dismissZoomOptionalMediaPrompt,
  isZoomOptionalMediaPromptText,
  pollZoomLobbySerially,
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

test('classifies Zoom automated-bot policy blocks after Join', () => {
  assert.equal(classifyZoomPostJoinBlock(
    'Automated bots aren\'t allowed to join this meeting. If this was a mistake and you are a human, sign in.'
  ), 'automated-bot-policy');
  assert.equal(classifyZoomPostJoinBlock(
    'Automated bots are not allowed to join this meeting.'
  ), 'automated-bot-policy');
  assert.equal(classifyZoomPostJoinBlock(
    'Automated bots aren\u2019t allowed\n  to join this meeting.'
  ), 'automated-bot-policy');
});

test('classifies only Zoom HTTPS sign-in redirects', () => {
  assert.equal(classifyZoomPostJoinBlock('', 'https://zoom.us/signin'), 'signin-required');
  assert.equal(classifyZoomPostJoinBlock('', 'https://us04web.zoom.us/signin/sso'), 'signin-required');
  assert.equal(classifyZoomPostJoinBlock('', 'https://example.test/signin'), undefined);
  assert.equal(classifyZoomPostJoinBlock('', 'https://zoom.us/signin-help'), undefined);
  assert.equal(classifyZoomPostJoinBlock('', 'http://zoom.us/signin'), undefined);
});

test('does not classify ordinary Zoom pre-join, CAPTCHA disclosure or lobby text as a policy block', () => {
  assert.equal(classifyZoomPostJoinBlock(
    'Zoom is protected by reCAPTCHA. Enter Meeting Info. Join.',
    'https://zoom.us/wc/123/join'
  ), undefined);
  assert.equal(classifyZoomPostJoinBlock(
    'Please wait. The meeting host will let you in soon.',
    'https://zoom.us/wc/123/join'
  ), undefined);
});

test('uses a stable non-retryable error for Zoom policy blocks', () => {
  const policyError = new ZoomGuestJoinBlockedError('automated-bot-policy');
  const signInError = new ZoomGuestJoinBlockedError('signin-required');

  assert.equal(policyError.name, 'ZoomGuestJoinBlockedError');
  assert.equal(policyError.retryable, false);
  assert.equal(policyError.maxRetries, 0);
  assert.match(policyError.message, /^ZOOM_AUTOMATED_BOTS_NOT_ALLOWED:/);
  assert.match(signInError.message, /^ZOOM_SIGN_IN_REQUIRED:/);
});

test('detects a Zoom policy block from the active web-client frame', async () => {
  const block = await detectZoomPostJoinBlock([
    {
      url: () => 'https://zoom.us/wc/123/join',
      bodyText: async () => 'Automated bots aren\'t allowed to join this meeting.',
    },
    {
      url: () => 'https://zoom.us/j/123',
      bodyText: async () => 'Zoom meeting shell',
    },
  ]);

  assert.equal(block, 'automated-bot-policy');
});

test('checks the top-level Zoom redirect when the web-client frame detaches', async () => {
  const block = await detectZoomPostJoinBlock([
    {
      url: () => 'https://zoom.us/wc/123/join',
      bodyText: async () => { throw new Error('frame detached'); },
    },
    {
      url: () => 'https://zoom.us/signin',
      bodyText: async () => { throw new Error('page navigating'); },
    },
  ]);

  assert.equal(block, 'signin-required');
});

test('polls the Zoom lobby serially without overlapping slow checks', async () => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;

  const outcome = await pollZoomLobbySerially(async () => {
    calls += 1;
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    return calls === 2 ? 'joined' : undefined;
  }, 100, 1);

  assert.equal(outcome, 'joined');
  assert.equal(calls, 2);
  assert.equal(maxInFlight, 1);
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
