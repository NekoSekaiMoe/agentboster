import { Logo } from '@/components/logo';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';

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
      className="mx-auto max-w-3xl px-4 md:mt-20"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ delay: 0.5 }}
    >
      <div className="mx-auto flex max-w-xl flex-col items-center gap-4 text-center leading-relaxed">
        <p className="flex items-center size-12 rounded-full border border-muted bg-muted/50 ">
          <Logo />
        </p>
        <p className="text-xl">Hi, How's it going?</p>
      </div>

      <div className="mx-auto mt-8 grid max-w-2xl gap-3 md:grid-cols-2">
        {quickPrompts.map((item) => (
          <Button
            key={item.title}
            type="button"
            variant="outline"
            className="h-auto min-h-28 items-start justify-start whitespace-normal rounded-2xl border-dashed px-4 py-4 text-left"
            onClick={() => onPromptSelect?.(item.prompt)}
          >
            <span className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">
                {item.title}
              </span>
              <span className="text-sm text-muted-foreground">
                {item.description}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </motion.div>
  );
};
