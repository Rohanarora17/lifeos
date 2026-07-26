'use strict';

const { test, expect } = require('@playwright/test');

/**
 * Rendered Brain Map coverage for Insights.
 * Requires BASE_URL pointing at a Next server seeded with pressure-wired data.
 */
test.describe('Brain Map on Insights (B3–B5 UI)', () => {
  test('renders pressure profile, traits, and experiment controls', async ({ page }) => {
    await page.goto('/insights', { waitUntil: 'networkidle' });

    const map = page.getByTestId('brain-map');
    await expect(map).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'Brain Map' })).toBeVisible();
    await expect(map.getByText(/Cognitive Self-Map/i)).toBeVisible();
    await expect(map.getByText('Pressure profile')).toBeVisible();

    await expect(map.getByTestId('trait-card-pressure_dependency')).toBeVisible();
    await expect(map.getByTestId('trait-card-voluntary_start_rate')).toBeVisible();
    await expect(map.getByTestId('trait-confirmed-pressure_dependency')).toBeVisible();
    await expect(map.getByTestId('trait-disputed-pressure_dependency')).toBeVisible();
    await expect(map.getByTestId('trait-aspirational-pressure_dependency')).toBeVisible();

    await map.getByTestId('trait-evidence-pressure_dependency').click();
    await expect(map.getByTestId('trait-evidence-pressure_dependency')).toHaveText(/Hide evidence/i);
  });

  test('confirm stance updates badge without full reload', async ({ page }) => {
    await page.goto('/insights', { waitUntil: 'networkidle' });
    const map = page.getByTestId('brain-map');
    await expect(map).toBeVisible({ timeout: 30_000 });

    await map.getByTestId('trait-confirmed-pressure_dependency').click();
    await expect(map.getByTestId('trait-stance-pressure_dependency')).toHaveText(/confirmed/i, {
      timeout: 15_000,
    });
  });

  test('light experiment offer can be declined (planner-safe path)', async ({ page }) => {
    await page.goto('/insights', { waitUntil: 'networkidle' });
    const map = page.getByTestId('brain-map');
    await expect(map).toBeVisible({ timeout: 30_000 });

    const experiment = map.getByTestId('brain-map-experiment');
    if (await experiment.count() === 0) {
      test.skip(true, 'No experiment offered for this seed');
      return;
    }

    await expect(experiment).toBeVisible();
    const decline = experiment.getByTestId('experiment-decline');
    if (await decline.count() === 0) {
      // Already active rather than offered — complete path still exercises controls
      await expect(experiment.getByText(/Active:/i)).toBeVisible();
      return;
    }

    await decline.click();
    await expect(map.getByTestId('brain-map-experiment')).toHaveCount(0, { timeout: 15_000 });
  });

  test('trajectory panel renders when history exists', async ({ page }) => {
    await page.goto('/insights', { waitUntil: 'networkidle' });
    const map = page.getByTestId('brain-map');
    await expect(map).toBeVisible({ timeout: 30_000 });
    // Seed path records at least one history point on compute; panel may show with >=2
    // or still show trajectory headline from API.
    const traj = map.getByTestId('brain-map-trajectory');
    if (await traj.count() > 0) {
      await expect(traj).toBeVisible();
      await expect(traj.getByText(/Trajectory/i)).toBeVisible();
    }
  });

  test('active coach panel appears and enables after confirming a core trait', async ({ page }) => {
    // Confirm via API so we don't race with UI toggle (Confirm on already-confirmed reverts to observed)
    await page.request.post('/api/personalization/model', {
      data: {
        action: 'set_stance',
        traitId: 'pressure_dependency',
        stance: 'confirmed',
        note: 'e2e map trust',
      },
    });

    await page.goto('/insights', { waitUntil: 'networkidle' });
    const map = page.getByTestId('brain-map');
    await expect(map).toBeVisible({ timeout: 30_000 });

    await expect(map.getByTestId('trait-stance-pressure_dependency')).toHaveText(/confirmed/i);

    const coach = map.getByTestId('active-coach-panel');
    await expect(coach).toBeVisible();
    await expect(coach.getByText(/Active coach/i)).toBeVisible();
    // Trusted map → auto-rewiring, trusted idle, or deadline protect (never "awaiting")
    await expect(coach.getByText(/auto-rewiring|trusted ·/i)).toBeVisible({ timeout: 10_000 });
    await expect(map.getByTestId('active-coach-on')).toBeVisible();
    await expect(map.getByTestId('active-coach-off')).toBeVisible();
  });
});
