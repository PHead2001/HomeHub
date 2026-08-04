export type ShoppingCategorizer = (input: {
  itemName: string;
  categories: string[];
}) => Promise<{ category: string }>;

export type ShoppingCategoryResolution = {
  category: string;
  usedFallback: boolean;
  reason?: 'configuration' | 'error' | 'invalid' | 'rate_limited' | 'refused' | 'timeout';
};

export async function resolveShoppingCategory({
  itemName,
  categories,
  selectedCategory,
  categorize,
  timeoutMs = 5_000,
}: {
  itemName: string;
  categories: string[];
  selectedCategory?: string;
  categorize: ShoppingCategorizer;
  timeoutMs?: number;
}): Promise<ShoppingCategoryResolution> {
  if (selectedCategory) {
    return { category: selectedCategory, usedFallback: false };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      categorize({ itemName, categories }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('categorization-timeout')), timeoutMs);
      }),
    ]);

    if (categories.includes(result.category)) {
      return { category: result.category, usedFallback: false };
    }
    return { category: 'Other', usedFallback: true, reason: 'invalid' };
  } catch (error) {
    const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const reason = error instanceof Error && error.message === 'categorization-timeout'
      ? 'timeout'
      : errorCode === 'configuration' || errorCode === 'rate_limited' || errorCode === 'refused' || errorCode === 'timeout'
        ? errorCode
        : 'error';
    return { category: 'Other', usedFallback: true, reason };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
