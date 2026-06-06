import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';

export type QuickPrompt = {
  title: string;
  description: string;
  prompt: string;
};

const quickPrompts: QuickPrompt[] = [
  {
    title: 'AgentBoster Startup',
    description: 'Customize your own AgentBoster.',
    prompt: '帮我配置 AgentBoster 的基本设置，包括模型选择和工具权限。',
  },
  {
    title: 'Daily Tasks',
    description: 'Great for recurring routines on a fixed schedule.',
    prompt: '创建一个每日任务，每天早上 9 点提醒我查看邮件和日程。',
  },
  {
    title: 'One-time Reminder',
    description:
      'Plan important personal tasks in advance so you do not forget.',
    prompt: '设置一个一次性提醒，明天下午 3 点提醒我参加会议。',
  },
  {
    title: 'Code Review',
    description: 'Get help reviewing your code and finding improvements.',
    prompt: '帮我审查当前项目的代码质量，找出可以优化的地方。',
  },
];

export const Overview = ({
  onPromptSelect,
}: {
  onPromptSelect?: (prompt: string) => void;
}) => {
  return (
    <motion.div
      key="overview"
      className="mx-auto flex w-full max-w-4xl flex-col px-4 pt-10 pb-24 md:min-h-full md:justify-center md:py-12"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ delay: 0.5 }}
    >
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-4 text-center leading-relaxed">
        <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Sparkles className="size-6" />
        </div>
        <div>
          <p className="font-semibold text-3xl tracking-tight md:text-4xl">
            欢迎使用 AgentBoster
          </p>
          <p className="mt-3 text-muted-foreground text-sm md:text-base">
            Ask, automate, schedule, and review agent work from one focused
            chat.
          </p>
        </div>
      </div>

      <div className="mx-auto mt-8 grid w-full max-w-2xl gap-3 md:grid-cols-2">
        {quickPrompts.map((item) => (
          <Button
            key={item.title}
            type="button"
            variant="outline"
            className="h-auto min-h-24 items-start justify-start whitespace-normal rounded-2xl border-dashed bg-card/70 px-4 py-4 text-left shadow-sm"
            onClick={() => onPromptSelect?.(item.prompt)}
          >
            <span className="flex flex-col gap-1">
              <span className="font-medium text-foreground text-sm">
                {item.title}
              </span>
              <span className="text-muted-foreground text-sm">
                {item.description}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </motion.div>
  );
};
