import { describe, expect, it } from 'vitest';
import { logTail, parseCompileErrors } from './editor.ts';

describe('unity editor log', () => {
  it('extracts C# compile errors as file:line', () => {
    const log = [
      'Asset Packages/x/Foo.cs.uid has no meta file, but it is in an immutable folder.',
      "Assets\\Scripts\\Story.cs(12,5): error CS0246: The type or namespace name 'Foo' could not be found",
      "Assets\\Scripts\\Story.cs(12,5): error CS0246: The type or namespace name 'Foo' could not be found",
      "Library\\PackageCache\\com.unity.analytics@1\\A.cs(3,1): error CS0103: The name 'X' does not exist",
      'Assets/Aige/Runtime/Hud.cs(1,1): warning CS0414: unused',
    ].join('\n');
    const errors = parseCompileErrors(log);
    expect(errors).toEqual([
      {
        file: 'Assets/Scripts/Story.cs',
        line: 12,
        column: 5,
        code: 'CS0246',
        message: "The type or namespace name 'Foo' could not be found",
      },
      {
        file: 'Library/PackageCache/com.unity.analytics@1/A.cs',
        line: 3,
        column: 1,
        code: 'CS0103',
        message: "The name 'X' does not exist",
      },
    ]);
    expect(logTail(log)).not.toContain('has no meta file');
  });
});
