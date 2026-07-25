import { Logo } from '@/components/logo';
import { useI18n } from '@/components/i18n-provider';
import { motion } from 'framer-motion';
import { useEffect, useState, useMemo } from 'react';

const CHINESE_POEMS = [
  '且将新火试新茶，诗酒趁年华。',
  '醉后不知天在水，满船清梦压星河。',
  '长风破浪会有时，直挂云帆济沧海。',
  '采菊东篱下，悠然见南山。',
  '纸上得来终觉浅，绝知此事要躬行。',
];

const ENGLISH_POEMS = [
  'An old silent pond...\nA frog jumps into the pond,\nsplash! Silence again.',
  'The light of a candle\nis transferred to another candle—\nspring twilight.',
  'A world of dew,\nand within every dewdrop\na world of struggle.',
];

const JAPANESE_POEMS = [
  '古池や蛙飛び込む水の音',
  '菜の花や月は東に日は西に',
  '露の世は露の世ながらさりながら',
];

// Track globally so the typewriter effect only plays once per browser session
let hasPlayedTypewriter = false;

export const Overview = ({
  onPromptSelect,
}: {
  onPromptSelect?: (prompt: string) => void;
}) => {
  const { locale } = useI18n();

  const poem = useMemo(() => {
    let poems = ENGLISH_POEMS;
    if (locale.startsWith('zh')) {
      poems = CHINESE_POEMS;
    } else if (locale === 'ja') {
      poems = JAPANESE_POEMS;
    }
    return poems[Math.floor(Math.random() * poems.length)];
  }, [locale]);

  const [displayedText, setDisplayedText] = useState(
    hasPlayedTypewriter ? poem : '',
  );

  useEffect(() => {
    if (hasPlayedTypewriter) return;

    let i = 0;
    const interval = setInterval(() => {
      setDisplayedText(poem.slice(0, i + 1));
      i++;
      if (i >= poem.length) {
        clearInterval(interval);
        hasPlayedTypewriter = true;
      }
    }, 80);

    return () => clearInterval(interval);
  }, [poem]);

  return (
    <motion.div
      key="overview"
      className="mx-auto flex w-full max-w-4xl flex-col items-center justify-center px-4 pt-20 pb-24 md:min-h-full md:py-12"
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ delay: 0.2 }}
    >
      <div className="flex flex-col items-center gap-6 text-center">
        <div className="flex items-center justify-center rounded-2xl p-4 text-primary opacity-80">
          <Logo width={64} height={64} />
        </div>
        <div className="min-h-24 max-w-md px-4">
          <p className="whitespace-pre-line text-muted-foreground text-sm tracking-wide md:text-base leading-relaxed">
            {displayedText}
            {!hasPlayedTypewriter && displayedText.length < poem.length && (
              <span className="inline-block h-4 w-1 animate-pulse bg-muted-foreground align-middle ml-1" />
            )}
          </p>
        </div>
      </div>
    </motion.div>
  );
};
