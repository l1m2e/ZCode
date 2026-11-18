/**
 * SCM 列表的“测试文件”判定。
 *
 * 这是纯展示投影：只决定列表是否显示某个条目，不改变 Git 快照、index 或
 * 写操作范围。判定只按路径段和文件名，不能用子串匹配，否则 `latest.ts`
 * 这类文件名会被误判成测试文件。
 */

/** 命中即视为测试目录的路径段（大小写不敏感）。 */
const TEST_DIRECTORY_SEGMENTS = new Set([
  "test",
  "tests",
  "__tests__",
  "__test__",
  "spec",
  "e2e",
  "testdata",
  "__snapshots__",
  "__mocks__",
  "__fixtures__",
  "cypress",
]);

/** 命中即视为测试文件的文件名模式；只匹配最后一段，避免目录名干扰。 */
const TEST_FILE_NAME_PATTERNS: readonly RegExp[] = [
  // foo.test.ts / foo.spec.tsx / foo.test-d.ts
  /\.(test|spec)\.[^./]+$/i,
  /\.test-d\.[^./]+$/i,
  // Go / Python / Ruby 的测试后缀与前缀约定
  /_test\.(go|py|rb|exs|dart)$/i,
  /^test_.*\.py$/i,
  /_spec\.rb$/i,
  // Java / Kotlin / C# / Swift / Scala / PHP 的 *Test(s) / *Spec 类命名
  /(test|tests|spec)\.(java|kt|kts|cs|swift|scala|php)$/i,
  // Jest snapshot
  /\.snap$/i,
  // Python 测试配置
  /^conftest\.py$/i,
];

/**
 * 判断 workspace 相对路径是否属于测试文件。
 *
 * 入参使用 `workspaceRelativePath`，允许 Windows 分隔符；空路径返回 false。
 */
export function isTestFilePath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName) {
    return false;
  }

  const directories = segments.slice(0, -1);
  if (directories.some((segment) => TEST_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))) {
    return true;
  }

  return TEST_FILE_NAME_PATTERNS.some((pattern) => pattern.test(fileName));
}
