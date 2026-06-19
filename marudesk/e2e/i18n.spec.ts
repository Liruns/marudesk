import { test, expect } from '@playwright/test';
import { launchApp, makeTempUserDataDir } from './helpers/app';

test('switches chrome labels to Korean from the appearance popover', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the shell starts in the default English locale.
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // When: the user opens Appearance and selects Korean.
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('menuitem', { name: 'Appearance…' })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await expect(page.getByRole('radio', { name: '한국어' })).toBeVisible({
      timeout: 1_000,
    });
    await page.getByRole('radio', { name: '한국어' }).click();

    // Then: always-visible chrome labels update without a reload.
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await expect(page.getByRole('banner', { name: '창 프레임' })).toBeVisible();
    await expect(page.getByRole('group', { name: '창 제어' })).toBeVisible();
    await expect(page.getByRole('button', { name: '최소화' })).toBeVisible();
    await expect(page.getByRole('button', { name: '설정' })).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: '활동 표시줄' }),
    ).toBeVisible();
    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('persists the selected locale across launches', async () => {
  const userDataDir = makeTempUserDataDir();

  const first = await launchApp({ userDataDir });
  try {
    // Given: the user chooses Korean in the first app session.
    await first.page.getByRole('button', { name: 'Settings' }).click();
    await first.page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await first.page.getByRole('radio', { name: '한국어' }).click();
    await expect(first.page.getByRole('button', { name: '설정' })).toBeVisible();
  } finally {
    await first.app.close();
  }

  const second = await launchApp({ userDataDir });
  try {
    // When: the app starts again with the same profile.
    await expect(second.page.locator('html')).toHaveAttribute('lang', 'ko');

    // Then: the persisted locale drives visible chrome labels.
    await expect(second.page.getByRole('button', { name: '설정' })).toBeVisible();
  } finally {
    await second.app.close();
  }
});

test('localizes the home launcher after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the default home surface is visible in English.
    await expect(page.getByPlaceholder('Search or enter a URL')).toBeVisible();

    // When: the user switches the app locale to Korean.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);

    // Then: the home launcher updates without recreating the tab.
    await expect(page.getByPlaceholder('검색하거나 URL 입력')).toBeVisible();
    await expect(page.getByRole('button', { name: /AI 채팅/ })).toBeVisible();
    await expect(page.getByText('실행 중인 앱을 보는 에이전트')).toBeVisible();
    await expect(page.getByText('새 탭 열기')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes tab strip controls after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the tab strip starts with English chrome.
    await expect(page.getByRole('tablist', { name: 'Open tabs' })).toBeVisible();

    // When: the user switches the app locale to Korean.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);

    // Then: tab-strip controls and context menu labels use Korean.
    await expect(page.getByRole('tablist', { name: '열린 탭' })).toBeVisible();
    await page.getByRole('button', { name: '새 탭' }).click();
    await expect(page.getByRole('tab')).toHaveCount(2);
    await page.getByRole('tab').first().click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '탭 고정' })).toBeVisible();
    await expect(
      page.getByRole('menuitem', { name: '닫기', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '다른 탭 닫기' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: '오른쪽 탭 닫기' })).toBeVisible();
  } finally {
    await app.close();
  }
});

test('localizes the settings shell after switching to Korean', async () => {
  const { app, page } = await launchApp();
  try {
    // Given: the app starts with English chrome.
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();

    // When: the user switches to Korean and opens the Settings tab.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('menuitem', { name: '설정' }).click();

    // Then: the settings navigation and current category labels use Korean.
    await expect(page.getByRole('heading', { name: '설정' })).toBeVisible();
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
    // Given: Korean is selected and the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('menuitem', { name: '설정' }).click();

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
    // Given: Korean is selected and the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('menuitem', { name: '설정' }).click();

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
    // Given: Korean is selected and the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('menuitem', { name: '설정' }).click();

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
    // Given: Korean is selected and the Settings tab is open.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);
    await page.getByRole('button', { name: '설정' }).click();
    await page.getByRole('menuitem', { name: '설정' }).click();

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
    // Given: Korean is selected for the current app session.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('menuitem', { name: 'Appearance…' }).click();
    await page.getByRole('radio', { name: '한국어' }).click();
    await page.mouse.click(5, 5);

    // When: Quick Open is opened from the keyboard.
    await page.keyboard.press('Control+P');

    // Then: Quick Open uses Korean labels and empty-state text.
    await expect(page.getByRole('dialog', { name: '파일로 이동' })).toBeVisible();
    await expect(page.getByText('워크스페이스가 열려 있지 않습니다.')).toBeVisible();

    await page.mouse.click(5, 5);

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
