import type { AgentApprovalMode, ReasoningEffort } from '../../../shared/settings';
import { useI18n } from '../../i18n/useI18n';
import {
  Field,
  GlobsField,
  InstructionsField,
  Section,
  Segmented,
  TextField,
} from './SettingsControls';
import { FallbackChain } from './FallbackChain';
import { useSettingsStore } from './store';

export function AgentCategory() {
  const { t } = useI18n();
  const agent = useSettingsStore((s) => s.settings.agent);
  const pcControl = useSettingsStore((s) => s.settings.pcControl);
  const update = useSettingsStore((s) => s.update);
  const approvalModeOptions = [
    { value: 'plan', label: t('settings.agent.approval.plan') },
    { value: 'read-only', label: t('settings.agent.approval.readOnly') },
    { value: 'ask', label: t('settings.agent.approval.ask') },
    { value: 'auto', label: t('settings.agent.approval.auto') },
  ] as const satisfies readonly {
    readonly value: AgentApprovalMode;
    readonly label: string;
  }[];
  const reasoningEffortOptions = [
    { value: 'minimal', label: t('settings.agent.reasoning.minimal') },
    { value: 'low', label: t('settings.agent.reasoning.low') },
    { value: 'medium', label: t('settings.agent.reasoning.medium') },
    { value: 'high', label: t('settings.agent.reasoning.high') },
  ] as const satisfies readonly {
    readonly value: ReasoningEffort;
    readonly label: string;
  }[];
  const onOffOptions = [
    { value: 'off', label: t('settings.agent.option.off') },
    { value: 'on', label: t('settings.agent.option.on') },
  ] as const;
  const autoCompactThresholdOptions = [
    { value: '0.7', label: '70%' },
    { value: '0.8', label: '80%' },
    { value: '0.9', label: '90%' },
  ] as const;
  // Snap the stored fraction to the nearest preset so the control always shows a
  // selected segment (older/custom values still round to a sensible bucket).
  const autoCompactThresholdValue =
    agent.autoCompact.threshold <= 0.75 ? '0.7' : agent.autoCompact.threshold >= 0.85 ? '0.9' : '0.8';

  return (
    <Section>
      <Field
        label={t('settings.agent.approval.label')}
        hint={t('settings.agent.approval.hint')}
      >
        <Segmented
          value={agent.approvalMode}
          options={approvalModeOptions}
          onChange={(approvalMode) => void update({ agent: { approvalMode } })}
        />
      </Field>
      <Field
        label={t('settings.agent.reasoning.label')}
        hint={t('settings.agent.reasoning.hint')}
      >
        <Segmented
          value={agent.reasoningEffort}
          options={reasoningEffortOptions}
          onChange={(reasoningEffort) => void update({ agent: { reasoningEffort } })}
        />
      </Field>
      <Field
        label={t('settings.agent.instructions.label')}
        hint={t('settings.agent.instructions.hint')}
      >
        <InstructionsField
          value={agent.instructions}
          onCommit={(instructions) => void update({ agent: { instructions } })}
        />
      </Field>
      <Field
        label={t('settings.agent.neverEdit.label')}
        hint={t('settings.agent.neverEdit.hint')}
      >
        <GlobsField
          value={agent.denyGlobs}
          onCommit={(denyGlobs) => void update({ agent: { denyGlobs } })}
        />
      </Field>
      <Field
        label={t('settings.agent.verifyCommand.label')}
        hint={t('settings.agent.verifyCommand.hint')}
      >
        <TextField
          value={agent.verifyCommand}
          placeholder="npm run typecheck"
          onCommit={(verifyCommand) => void update({ agent: { verifyCommand } })}
        />
      </Field>
      <Field
        label={t('settings.agent.fallback.label')}
        hint={t('settings.agent.fallback.hint')}
      >
        <Segmented
          value={agent.fallback.enabled ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) =>
            void update({ agent: { fallback: { ...agent.fallback, enabled: v === 'on' } } })
          }
        />
      </Field>
      {agent.fallback.enabled ? (
        <div className="px-4 py-3">
          <FallbackChain
            order={agent.fallback.order}
            onChange={(order) =>
              void update({ agent: { fallback: { ...agent.fallback, order } } })
            }
          />
        </div>
      ) : null}
      <Field
        label={t('settings.agent.autoCompact.label')}
        hint={t('settings.agent.autoCompact.hint')}
      >
        <Segmented
          value={agent.autoCompact.enabled ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) =>
            void update({ agent: { autoCompact: { ...agent.autoCompact, enabled: v === 'on' } } })
          }
        />
      </Field>
      {agent.autoCompact.enabled ? (
        <Field
          label={t('settings.agent.autoCompactThreshold.label')}
          hint={t('settings.agent.autoCompactThreshold.hint')}
        >
          <Segmented
            value={autoCompactThresholdValue}
            options={autoCompactThresholdOptions}
            onChange={(v) =>
              void update({
                agent: { autoCompact: { ...agent.autoCompact, threshold: Number(v) } },
              })
            }
          />
        </Field>
      ) : null}
      <Field
        label={t('settings.agent.pcControl.label')}
        hint={t('settings.agent.pcControl.hint')}
      >
        <Segmented
          value={pcControl.enabled ? 'on' : 'off'}
          options={onOffOptions}
          onChange={(v) => void update({ pcControl: { enabled: v === 'on' } })}
        />
      </Field>
    </Section>
  );
}
