import Image from 'next/image';

export function Logo({
  width = 64,
  height = 64,
}: {
  width?: number;
  height?: number;
}) {
  return <Image src="/icon.png" width={width} height={height} alt="icon" />;
}
