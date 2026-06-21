import { test, expect, type Page } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';
import { runCommand } from './helpers/mission-control';

/**
 * Localization (English ↔ Korean). The locale switch lives in Settings →
 * Appearance now: Mission Control removed the activity-bar gear + its Appearance
 * popover, so the language radiogroup in the Settings "Appearance" category is the
 * single switch. Settings itself is summoned as a full-area instrument from the
 * ⌘K command palette (there is no tab strip / activity bar to open it from).
 *
 * Each spec switches to Korean and asserts that a real surface re-localizes —
 * the title-bar chrome, the Settings shell, and the per-category settings panels
 * (MCP, providers, agent, data) — plus the keyboard palettes (Quick Open / tab
 * search) that survive the redesign. No AI provider or workspace is needed.
 */

/**
 * Open Settings as an instrument and flip the locale to Korean from the
 * Appearance category's language radiogroup. Settings is opened in English (the
 * palette command labels are not localized), the Appearance nav chip + the
 * "한국어" radio are clicked, then the whole UI re-renders in Korean with Settings
 * left open on the (now "테마") Appearance category.
 */
async function openSettingsInKorean(page: Page): Promise<void> {
  await runCommand(page, 'Open Settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // The Appearance category hosts the language radiogroup (Segmented control).
  await page.getByRole('button', { name: 'Appearance' }).click();
  await expect(page.getByRole('radio', { name: '한국어' })).toBeVisible();
  await page.getByRole('radio', { name: '한국어' }).click();
  // The switch re-localizes the shell live; the Settings title proves it landed.
  await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
}

test('switches chrome labels to Korean from Settings', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the shell starts in the default English locale.
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('banner', { name: 'Window chrome' })).toBeVisible();

    // When: the user switches the app locale to Korean from Settings.
    await openSettingsInKorean(page);

    // Then: always-visible title-bar chrome updates without a reload.
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('banner', { name: '창 프레임' })).toBeVisible();
    await expect(page.getByRole('group', { name: '창 제어' })).toBeVisible();
    await expect(page.getByRole('button', { name: '최소화' })).toBeVisible();

    // And: switching back to English restores the chrome labels live.
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('banner', { name: 'Window chrome' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('persists the selected locale across launches', async () => {
  const userDataDir = makeTempUserDataDir();

  const first = await launchApp({ userDataDir });
  try {
    // Given: the user chooses Korean in the first app session.
    await openSettingsInKorean(first.page);
    await expect(first.page.locator('html')).toHaveAttribute('lang', 'ko');
  } finally {
    await first.app.close();
  }

  const second = await launchApp({ userDataDir });
  try {
    // When: the app starts again with the same profile.
    await expect(second.page.locator('html')).toHaveAttribute('lang', 'ko');

    // Then: the persisted locale drives visible chrome labels.
    await expect(
      second.page.getByRole('banner', { name: '창 프레임' }),
    ).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('localizes the settings shell after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given/When: Korean is selected and Settings is open on Appearance ("테마").
    await openSettingsInKorean(page);

    // Then: the settings navigation and current category labels use Korean.
    await expect(page.getByRole('navigation', { name: '설정 카테고리' })).toBeVisible();
    await expect(page.getByPlaceholder('설정 검색')).toBeVisible();
    await expect(page.getByRole('button', { name: '테마' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '테마' })).toBeVisible();
    await expect(
      page.getByText('테마, 인터페이스 확대/축소, UI 글꼴.'),
    ).toBeVisible();
    // "테마" appears as the nav chip, the section heading, and a row label —
    // scope to the first so this asserts presence without a strict-mode clash.
    await expect(page.getByText('테마', { exact: true }).first()).toBeVisible();
    await page.getByPlaceholder('설정 검색').fill('저장');
    await expect(page.getByRole('button', { name: '데이터 및 저장소' })).toBeVisible();
    await page.getByPlaceholder('설정 검색').fill('없는검색어');
    await expect(page.getByText('일치하는 설정 없음')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes settings MCP panels after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: Korean is selected and the Settings instrument is open.
    await openSettingsInKorean(page);

    // When: the user opens the MCP Servers category.
    await page.getByRole('button', { name: 'MCP 서버' }).click();

    // Then: MCP server controls and empty states use Korean.
    await expect(page.getByRole('button', { name: '새로고침' })).toBeVisible();
    await expect(page.getByRole('button', { name: '설정 파일 열기' })).toBeVisible();
    await expect(
      page.getByText('설정된 MCP 서버가 없습니다. 설정 파일을 열어 추가하세요.'),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes AI provider settings after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: Korean is selected and the Settings instrument is open.
    await openSettingsInKorean(page);

    // When: the user opens the AI Providers category.
    await page.getByRole('button', { name: 'AI 제공자' }).click();

    // Then: provider settings chrome and status labels use Korean.
    await expect(page.getByRole('heading', { name: 'AI 제공자' })).toBeVisible();
    await expect(
      page.getByText('키는 OS 키체인(safeStorage)에 암호화되어 저장됩니다.'),
    ).toBeVisible();
    await expect(page.getByText('키 없음').first()).toBeVisible();
    await expect(page.getByText('사용자 지정 엔드포인트', { exact: true })).toBeVisible();
    await expect(page.getByText('아직 사용자 지정 엔드포인트가 없습니다.')).toBeVisible();

    // When: the user expands a key-backed provider card.
    const anthropicCard = page.getByRole('button', { name: 'Anthropic 키 없음' });
    if ((await anthropicCard.getAttribute('aria-expanded')) !== 'true') {
      await anthropicCard.click();
    }

    // Then: the key editor controls are localized too.
    await expect(page.getByText('API 키', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '키 저장' })).toBeVisible();
    await expect(page.getByRole('button', { name: '키 보이기' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes AI agent settings after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: Korean is selected and the Settings instrument is open.
    await openSettingsInKorean(page);

    // When: the user opens the AI Agent category.
    await page.getByRole('button', { name: 'AI 에이전트' }).click();

    // Then: core agent settings labels and segmented options use Korean.
    await expect(page.getByRole('heading', { name: 'AI 에이전트' })).toBeVisible();
    await expect(page.getByText('승인 모드', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '계획' })).toBeVisible();
    await expect(page.getByRole('radio', { name: '읽기 전용' })).toBeVisible();
    await expect(page.getByText('추론 강도', { exact: true })).toBeVisible();
    await expect(page.getByRole('radio', { name: '중간' })).toBeVisible();
    await expect(page.getByText('사용자 지정 지침', { exact: true })).toBeVisible();
    await expect(page.getByText('절대 수정하지 않을 경로', { exact: true })).toBeVisible();

    // When: the user enables model fallback. Scope to the fallback row by its
    // label — other on/off toggles (e.g. the runtime tool groups) share "켬".
    await page
      .locator('div.justify-between', { hasText: '모델 대체' })
      .getByRole('radio', { name: '켬' })
      .first()
      .click();

    // Then: fallback-chain helper text and actions are localized.
    await expect(page.getByText('모델 대체', { exact: true })).toBeVisible();
    await expect(
      page.getByText('아직 대체 모델이 없습니다. 아래에서 하나 이상 추가하세요.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '모델 추가' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes data settings after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: Korean is selected and the Settings instrument is open.
    await openSettingsInKorean(page);

    // When: the user opens Data & Storage.
    await page.getByRole('button', { name: '데이터 및 저장소' }).click();

    // Then: persistence and storage actions use Korean.
    await expect(page.getByRole('heading', { name: '데이터 및 저장소' })).toBeVisible();
    await expect(page.getByText('AI 채팅 세션 저장', { exact: true })).toBeVisible();
    await expect(page.getByText('시작할 때 탭 복원', { exact: true })).toBeVisible();
    await expect(page.getByText('세션 저장소', { exact: true })).toBeVisible();
    // Both the Data-storage and the Memory sections have a "새로고침" (Refresh)
    // button under this category, so scope to the first like "폴더 열기" below.
    await expect(page.getByRole('button', { name: '새로고침' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: '폴더 열기' }).first()).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes keyboard palettes after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: Korean is selected for the current app session. Settings stays open
    // as an instrument tab, so the tab switcher below has a "current" tab to mark.
    await openSettingsInKorean(page);

    // When: Quick Open is opened from the keyboard.
    await page.keyboard.press('Control+P');

    // Then: Quick Open uses Korean labels and empty-state text.
    await expect(page.getByRole('dialog', { name: '파일로 이동' })).toBeVisible();
    await expect(page.getByText('워크스페이스가 열려 있지 않습니다.')).toBeVisible();

    await page.keyboard.press('Escape');

    // When: the tab switcher palette is opened from the keyboard.
    await page.keyboard.press('Control+Shift+A');

    // Then: tab-search chrome uses Korean labels too.
    await expect(page.getByRole('dialog', { name: '탭 검색' })).toBeVisible();
    await expect(page.getByPlaceholder('탭 검색…')).toBeVisible();
    await expect(page.getByText('현재')).toBeVisible();
  } finally {
    await app.close();
  }
});
