/**
 * 增量渲染组件
 * 对大型列表进行批量渲染，避免一次性渲染造成卡顿
 */
import { useState, useEffect, useMemo, type ReactNode } from "react";

interface IncrementalRendererProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  batchSize?: number;
  batchDelay?: number;
  className?: string;
  placeholder?: ReactNode;
}

export function IncrementalRenderer<T>({
  items,
  renderItem,
  batchSize = 10,
  batchDelay = 16, // ~60fps
  className = "",
  placeholder,
}: IncrementalRendererProps<T>) {
  const [renderedCount, setRenderedCount] = useState(batchSize);

  // 当items变化时重置
  useEffect(() => {
    setRenderedCount(batchSize);
  }, [items.length, batchSize]);

  // 批量增加渲染数量
  useEffect(() => {
    if (renderedCount >= items.length) return;

    const timer = setTimeout(() => {
      setRenderedCount((prev) => Math.min(prev + batchSize, items.length));
    }, batchDelay);

    return () => clearTimeout(timer);
  }, [renderedCount, items.length, batchSize, batchDelay]);

  const visibleItems = useMemo(() => {
    return items.slice(0, renderedCount);
  }, [items, renderedCount]);

  const isComplete = renderedCount >= items.length;

  return (
    <div className={className}>
      {visibleItems.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
      {!isComplete && placeholder && <div>{placeholder}</div>}
    </div>
  );
}
