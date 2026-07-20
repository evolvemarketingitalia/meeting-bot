import type { Frame, Page } from 'playwright';

type ZoomPrejoinRoot = Frame | Page;
type ZoomOptionalMediaPromptKind = 'see' | 'hear';

const OPTIONAL_MEDIA_PROMPTS: Record<ZoomOptionalMediaPromptKind, RegExp> = {
  see: /(?:Do you want people to see you in the meeting\?|Möchten Sie, dass andere Sie im Meeting sehen|Vuoi che le persone ti vedano)/i,
  hear: /(?:Do you want people to hear you in the meeting\?|Möchten Sie, dass andere Sie im Meeting hören|Vuoi che le persone ti sentano)/i,
};
const OPTIONAL_MEDIA_PROMPT = /(?:Do you want people to (?:see|hear) you in the meeting\?|Möchten Sie, dass andere Sie im Meeting (?:sehen|hören)|Vuoi che le persone ti (?:vedano|sentano))/i;
const OPTIONAL_MEDIA_COPY = /(?:microphone and camera|Mikrofon und Kamera|microfono e videocamera)/i;
const CONTINUE_WITHOUT_MEDIA = /^(?:Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren|Continua senza microfono e videocamera)$/i;
const CONTINUE_WITHOUT_MEDIA_COPY = /(?:Continue without microphone and camera|Ohne Mikrofon und Kamera fortfahren|Continua senza microfono e videocamera)/i;
const NEXT_OPTIONAL_MEDIA_PROMPT_TIMEOUT = 1_500;
const ZOOM_JOIN_CLICK_ATTEMPTS = 3;
const ZOOM_AUTOMATED_BOT_BLOCK = /Automated bots (?:aren't|are not) allowed to join this meeting\./i;

export type ZoomPostJoinBlock = 'automated-bot-policy' | 'signin-required';

export interface ZoomPostJoinContext {
  url: () => string;
  bodyText: () => Promise<string>;
}

export function classifyZoomPostJoinBlock(
  bodyText?: string | null,
  pageUrl?: string | null,
): ZoomPostJoinBlock | undefined {
  const normalizedBodyText = (bodyText ?? '')
    .normalize('NFKC')
    .replace(/\u2019/g, '\u0027')
    .replace(/\s+/g, ' ')
    .trim();
  if (ZOOM_AUTOMATED_BOT_BLOCK.test(normalizedBodyText)) {
    return 'automated-bot-policy';
  }

  if (pageUrl) {
    try {
      const url = new URL(pageUrl);
      const isZoomHost = url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us');
      const isSignInPath = /^\/signin(?:\/|$)/i.test(url.pathname);
      if (url.protocol === 'https:' && isZoomHost && isSignInPath) {
        return 'signin-required';
      }
    } catch {}
  }

  return undefined;
}

export async function detectZoomPostJoinBlock(
  contexts: ZoomPostJoinContext[],
): Promise<ZoomPostJoinBlock | undefined> {
  for (const context of contexts) {
    try {
      const pageUrl = context.url();
      const redirectBlock = classifyZoomPostJoinBlock('', pageUrl);
      if (redirectBlock) return redirectBlock;

      const block = classifyZoomPostJoinBlock(await context.bodyText(), pageUrl);
      if (block) return block;
    } catch {
      // A detached Zoom iframe must not prevent checking the top-level redirect.
    }
  }

  return undefined;
}

export async function pollZoomLobbySerially<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<T | undefined> {
  return new Promise(resolve => {
    let settled = false;
    let nextPollTimeout: NodeJS.Timeout | undefined;
    const overallTimeout = setTimeout(() => settle(undefined), timeoutMs);

    function settle(outcome: T | undefined) {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      if (nextPollTimeout) clearTimeout(nextPollTimeout);
      resolve(outcome);
    }

    const poll = async () => {
      if (settled) return;
      try {
        const outcome = await check();
        if (outcome !== undefined) {
          settle(outcome);
          return;
        }
      } catch {
        // Navigation can transiently detach the Zoom frame; retry serially.
      }

      if (!settled) {
        nextPollTimeout = setTimeout(() => void poll(), intervalMs);
      }
    };

    void poll();
  });
}

const getPromptKind = (text: string): ZoomOptionalMediaPromptKind | undefined =>
  (Object.keys(OPTIONAL_MEDIA_PROMPTS) as ZoomOptionalMediaPromptKind[])
    .find(kind => OPTIONAL_MEDIA_PROMPTS[kind].test(text));

export const isZoomOptionalMediaPromptText = (text?: string | null): boolean => {
  const promptText = text ?? '';
  return getPromptKind(promptText) !== undefined
    && OPTIONAL_MEDIA_COPY.test(promptText)
    && CONTINUE_WITHOUT_MEDIA_COPY.test(promptText);
};

export async function dismissZoomOptionalMediaPrompt(
  root: ZoomPrejoinRoot,
  timeout = 2_500,
): Promise<boolean> {
  const overlays = root.locator('.ReactModal__Overlay.ReactModal__Overlay--after-open');
  let prompt = overlays.filter({ hasText: OPTIONAL_MEDIA_PROMPT }).last();
  const dismissedKinds = new Set<ZoomOptionalMediaPromptKind>();
  let dismissed = false;

  for (let attempt = 0; attempt < Object.keys(OPTIONAL_MEDIA_PROMPTS).length; attempt += 1) {
    const visible = await prompt.waitFor({ state: 'visible', timeout })
      .then(() => true)
      .catch(() => false);
    if (!visible) return dismissed;

    const promptText = await prompt.innerText().catch(() => '');
    const promptKind = getPromptKind(promptText);
    if (!promptKind || !isZoomOptionalMediaPromptText(promptText) || dismissedKinds.has(promptKind)) {
      return dismissed;
    }

    const continueWithoutMedia = overlays
      .filter({ hasText: OPTIONAL_MEDIA_PROMPTS[promptKind] })
      .last()
      .getByRole('button', { name: CONTINUE_WITHOUT_MEDIA })
      .first();
    const buttonVisible = await continueWithoutMedia.waitFor({ state: 'visible', timeout: 1_000 })
      .then(() => true)
      .catch(() => false);
    if (!buttonVisible) return dismissed;

    const clicked = await continueWithoutMedia.click()
      .then(() => true)
      .catch(() => false);
    if (!clicked) return false;

    const hidden = await continueWithoutMedia.waitFor({ state: 'hidden', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!hidden) return false;

    dismissedKinds.add(promptKind);
    dismissed = true;
    const nextKind = (Object.keys(OPTIONAL_MEDIA_PROMPTS) as ZoomOptionalMediaPromptKind[])
      .find(kind => !dismissedKinds.has(kind));
    if (!nextKind) return true;

    prompt = overlays.filter({ hasText: OPTIONAL_MEDIA_PROMPTS[nextKind] }).last();
    timeout = NEXT_OPTIONAL_MEDIA_PROMPT_TIMEOUT;
  }

  return dismissed;
}

export async function clickZoomJoinWithOptionalMediaPromptRetry(
  root: ZoomPrejoinRoot,
  clickJoin: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < ZOOM_JOIN_CLICK_ATTEMPTS; attempt += 1) {
    try {
      await clickJoin();
    } catch (clickError) {
      if (attempt === ZOOM_JOIN_CLICK_ATTEMPTS - 1) throw clickError;
      if (!await dismissZoomOptionalMediaPrompt(root, 1_000).catch(() => false)) {
        throw clickError;
      }
      continue;
    }

    const dismissedAfterClick = await dismissZoomOptionalMediaPrompt(root, 1_500)
      .catch(() => false);
    if (!dismissedAfterClick) return;
    if (attempt === ZOOM_JOIN_CLICK_ATTEMPTS - 1) {
      throw new Error('Zoom Join remained blocked by optional media prompts');
    }
  }
}
