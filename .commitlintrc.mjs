import nxScope from '@commitlint/config-nx-scopes';

const { getProjects } = nxScope.utils;

export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': async (ctx) => [
      2,
      'always',
      [
        ...(await getProjects(ctx, ({ tags }) => {
          if (!tags) return false;
          return !tags.includes('stage:end-of-life');
        })),
        'root',
        'release',
      ],
    ],
  },
};
