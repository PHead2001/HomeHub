const DEFAULT_MODELS = {
  default: 'gpt-5.6-luna',
  categorization: 'gpt-5.6-luna',
  recipe: 'gpt-5.6-terra',
  maintenance: 'gpt-5.6-luna',
} as const;
const modelNamePattern = /^(?:gpt-[a-z0-9._-]+|o\d[a-z0-9._-]*)$/;

const readModelName = (environmentName: string, fallback: string) => {
  const value = process.env[environmentName]?.trim() || fallback;
  if (!modelNamePattern.test(value)) {
    throw new Error(`${environmentName} contains an invalid OpenAI model name.`);
  }
  return value;
};

export const openAiModels = {
  default: readModelName('OPENAI_DEFAULT_MODEL', DEFAULT_MODELS.default),
  categorization: readModelName('OPENAI_CATEGORIZATION_MODEL', DEFAULT_MODELS.categorization),
  recipe: readModelName('OPENAI_RECIPE_MODEL', DEFAULT_MODELS.recipe),
  maintenance: readModelName('OPENAI_MAINTENANCE_MODEL', DEFAULT_MODELS.maintenance),
} as const;

export const hasOpenAiApiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
