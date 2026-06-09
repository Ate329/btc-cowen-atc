export function withPathDigits<TGenerator>(generator: TGenerator, digits: number): TGenerator {
  const generatorWithDigits = generator as TGenerator & {
    digits?: (digits: number) => TGenerator;
  };

  return generatorWithDigits.digits?.(digits) ?? generator;
}
