// Task C banner expectations, derived from the configuration instead of hard-coded model names. Pure (no harness,
// no fixture), so it is unit-testable.
import type { CodeCraftConfig } from '../../src/trueforge/config';

export interface BannerModels {
  /** The model that was refused: codecraft.primaryModel, or the model standing in for it in this scenario. */
  primary: string;
  /** The model that took over: codecraft.fallbackModel. */
  fallback: string;
}

/**
 * The models the takeover banner must name. Task C replaces the configured primary (codecraft.primaryModel) with a
 * TEST-ONLY invalid-key model, so `primaryStandIn` is the model that was actually refused; the fallback is always
 * the configured codecraft.fallbackModel.
 */
export function expectedBannerModels(cfg: Pick<CodeCraftConfig, 'primaryModel' | 'fallbackModel'>, primaryStandIn?: string): BannerModels {
  return { primary: primaryStandIn ?? cfg.primaryModel, fallback: cfg.fallbackModel };
}

/**
 * Strict banner check: the spec wording for a rejected key, HTTP 401, the refused primary by name, and the
 * configured fallback by name, taking over automatically.
 */
export function bannerNamesTakeover(banner: string, m: BannerModels): boolean {
  return (
    banner.startsWith('Provider key rejected: update it in TrueForge Settings.') &&
    banner.includes(`The primary model ${m.primary} was refused (HTTP 401);`) &&
    banner.includes(`CodeCraft switched to the fallback model ${m.fallback} automatically and is continuing your request.`)
  );
}
