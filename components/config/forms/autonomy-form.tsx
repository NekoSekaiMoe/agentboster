'use client';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useI18n } from '@/components/i18n-provider';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigSection } from '@/hooks/use-config-section';
import type { AutonomyConfig } from '@/types/config/autonomy';

import { Field, SectionIssues } from './shared';

export function AutonomyForm() {
  const { issues, value, updateValue } = useConfigSection('autonomy');
  const { t } = useI18n();
  const autonomy = (value ?? {
    level: 'supervised',
    max_steps: 20,
    yolo: false,
  }) as AutonomyConfig;
  const toolLoop = autonomy.tool_loop_limits ?? {};
  const micro = autonomy.microcompact ?? {};

  return (
    <div className="space-y-6">
      <SectionIssues issues={issues} />

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">
            {t('config.forms.autonomy.title')}
          </CardTitle>
          <CardDescription>
            {t('config.forms.autonomy.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label={t('config.forms.autonomy.level')}>
            <Select
              value={autonomy.level}
              onValueChange={(nextValue) =>
                updateValue({
                  ...autonomy,
                  level: nextValue as AutonomyConfig['level'],
                })
              }
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={t('config.forms.autonomy.chooseLevel')}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="supervised">supervised</SelectItem>
                <SelectItem value="full">full</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field label={t('config.forms.autonomy.maxSteps')}>
            <Input
              min="0"
              type="number"
              value={autonomy.max_steps}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  max_steps: Number.isNaN(parsed) ? 0 : parsed,
                });
              }}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">YOLO / 全自动模式</CardTitle>
          <CardDescription>
            开启后，对 Web workflow 内的工具（sandbox/exec/browser 等）跳过 L1
            风险评分与 L2 审批提示，agent 自主执行。用户显式配置的黑名单 规则
            (block) 仍然生效，这是 YOLO 唯一不会越过的硬墙。
            <strong>作用范围仅限 Web 端会话</strong>：CLI 本机执行的{' '}
            <code>local_*</code> 工具由 CLI 自身的 <code>--yolo</code>{' '}
            参数独立控制，与本开关无关。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Checkbox
            id="yolo-toggle"
            checked={autonomy.yolo === true}
            onCheckedChange={(checked) =>
              updateValue({ ...autonomy, yolo: checked === true })
            }
          />
          <Label htmlFor="yolo-toggle" className="text-sm">
            {autonomy.yolo
              ? '已开启 — 危险工具仍需确认'
              : '已关闭 — 每个高危操作都需确认'}
          </Label>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">Team Leader 模式</CardTitle>
          <CardDescription>
            开启后，主 agent 遇到复杂任务会主动拆解为子任务，通过 subAgent
            (spawn_async) + barrier + handoff 并行编排多个子 agent。
            适合需要多步、多角色协作的复杂工作流。关闭时 agent
            仍可用这些工具，只是不会优先拆解。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <Checkbox
            id="team-leader-toggle"
            checked={autonomy.team_leader === true}
            onCheckedChange={(checked) =>
              updateValue({ ...autonomy, team_leader: checked === true })
            }
          />
          <Label htmlFor="team-leader-toggle" className="text-sm">
            {autonomy.team_leader
              ? '已开启 — 复杂任务自动拆解并 fan-out'
              : '已关闭 — agent 倾向串行处理'}
          </Label>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">工具循环熔断器</CardTitle>
          <CardDescription>
            防止 agent 陷入死循环烧 API 额度。留空使用默认值 (3/3/8/3)。设为 0
            可禁用单个熔断器。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="连续格式错误轮数上限">
            <Input
              min="0"
              type="number"
              placeholder="3"
              value={toolLoop.max_malformed_turns ?? ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  tool_loop_limits: {
                    ...toolLoop,
                    max_malformed_turns: Number.isNaN(parsed)
                      ? undefined
                      : parsed,
                  },
                });
              }}
            />
          </Field>
          <Field label="连续相同失败轮数上限">
            <Input
              min="0"
              type="number"
              placeholder="3"
              value={toolLoop.max_failure_turns ?? ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  tool_loop_limits: {
                    ...toolLoop,
                    max_failure_turns: Number.isNaN(parsed)
                      ? undefined
                      : parsed,
                  },
                });
              }}
            />
          </Field>
          <Field label="连续全失败轮数上限">
            <Input
              min="0"
              type="number"
              placeholder="8"
              value={toolLoop.max_all_error_rounds ?? ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  tool_loop_limits: {
                    ...toolLoop,
                    max_all_error_rounds: Number.isNaN(parsed)
                      ? undefined
                      : parsed,
                  },
                });
              }}
            />
          </Field>
          <Field label="循环重复次数上限">
            <Input
              min="0"
              type="number"
              placeholder="3"
              value={toolLoop.max_cycle_repetitions ?? ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  tool_loop_limits: {
                    ...toolLoop,
                    max_cycle_repetitions: Number.isNaN(parsed)
                      ? undefined
                      : parsed,
                  },
                });
              }}
            />
          </Field>
        </CardContent>
      </Card>

      <Card className="shadow-none">
        <CardHeader>
          <CardTitle className="text-base">上下文压缩 (Microcompact)</CardTitle>
          <CardDescription>
            发送给 LLM 前折叠旧的工具结果，避免上下文爆表。无需 LLM
            调用，本地完成。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <Field label="启用">
            <Checkbox
              checked={micro.enabled !== false}
              onCheckedChange={(checked) =>
                updateValue({
                  ...autonomy,
                  microcompact: { ...micro, enabled: checked === true },
                })
              }
            />
          </Field>
          <Field label="保留最近 N 个结果">
            <Input
              min="1"
              type="number"
              placeholder="4"
              value={micro.keep_recent ?? ''}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                updateValue({
                  ...autonomy,
                  microcompact: {
                    ...micro,
                    keep_recent: Number.isNaN(parsed) ? undefined : parsed,
                  },
                });
              }}
            />
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
