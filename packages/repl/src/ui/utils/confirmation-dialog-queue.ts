export function createConfirmationDialogQueue(): <T>(
  present: () => Promise<T>,
) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();

  return <T>(present: () => Promise<T>): Promise<T> => {
    const result = tail.then(present);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
