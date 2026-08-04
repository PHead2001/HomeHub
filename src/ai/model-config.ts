const DEFAULT_MODEL = 'gpt-5-mini';
const modelNamePattern = /^(?:gpt-[a-z0-9._-]+|o\d[a-z0-9._-]*)$/;

const readModelName = (environmentName: string) => {
  const value = process.env[environmentName]?.trim() || DEFAULT_MODEL;
  if (!modelNamePattern.test(value)) {
    throw new Error(`${environmentName} contains an invalid OpenAI model name.`);
  }
  return value;
};

export const openAiModels = {
  default: readModelName('OPENAI_DEFAULT_MODEL'),
  categorization: readModelName('OPENAI_CATEGORIZATION_MODEL'),
  recipe: readModelName('OPENAI_RECIPE_MODEL'),
  maintenance: readModelName('OPENAI_MAINTENANCE_MODEL'),
} as const;

export const hasOpenAiApiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
