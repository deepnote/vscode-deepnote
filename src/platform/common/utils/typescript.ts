type IsAny<T> = 0 extends 1 & T ? true : false;
type ArrayElement<T> = T extends readonly unknown[] ? T[number] : never;
type IsNonAnyString<T> = IsAny<T> extends true ? false : [T] extends [string] ? true : false;
type IsNonAnyStringArray<T> = IsAny<T> extends true
    ? false
    : IsAny<ArrayElement<T>> extends true
    ? false
    : [T] extends [string[]]
    ? true
    : false;

export type AssertNonAnyString<T> = IsNonAnyString<T> extends true ? true : 'ERROR: expected a non-any string';
export type AssertNonAnyStringArray<T> = IsNonAnyStringArray<T> extends true
    ? true
    : 'ERROR: expected a non-any string array';

/**
 * Static check test cases fixtures
 */
// oxlint-disable-next-line no-explicit-any
declare const testAnyType: any;
declare const testStringType: string;
declare const testNumberType: number;
// oxlint-disable-next-line no-explicit-any
declare const testAnyArrayType: any[];
declare const testStringArrayType: string[];
declare const testNumberArrayType: number[];

/**
 * Static check test cases for AssertNonAnyString
 */
// @ts-expect-error `testAnyType` is `any`, not a string
true satisfies AssertNonAnyString<typeof testAnyType>;
// @ts-expect-error `testNumberType` is `number`, not a string
true satisfies AssertNonAnyString<typeof testNumberType>;

true satisfies AssertNonAnyString<typeof testStringType>;

/**
 * Static check test cases for AssertNonAnyStringArray
 */
// @ts-expect-error `testAnyType` is `any`, not a string array
true satisfies AssertNonAnyStringArray<typeof testAnyType>;
// @ts-expect-error `testNumberArrayType` is `number[]`, not a string array
true satisfies AssertNonAnyStringArray<typeof testNumberArrayType>;
// @ts-expect-error `testAnyArrayType` is `any[]`, not a string array
true satisfies AssertNonAnyStringArray<typeof testAnyArrayType>;

true satisfies AssertNonAnyStringArray<typeof testStringArrayType>;
