/**
 * Mock of SillyTavern's i18n module for tests.
 * The `t` tag acts as a passthrough — returns the English string with interpolations applied.
 */
export function t(strings, ...values) {
    return strings.reduce((result, string, i) => result + string + (values[i] !== undefined ? values[i] : ''), '');
}

export function translate(text) {
    return text;
}
