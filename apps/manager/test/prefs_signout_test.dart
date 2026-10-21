import 'package:deligro_manager/data/manager_repository.dart';
import 'package:deligro_manager/models/account.dart';
import 'package:deligro_manager/state/account.dart';
import 'package:deligro_manager/state/providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements ManagerRepository {}

class _SignedIn extends Notifier<bool> {
  @override
  bool build() => true;
  void set(bool v) => state = v;
}

final _signedIn = NotifierProvider<_SignedIn, bool>(_SignedIn.new);

void main() {
  test("one person's push switches are not shown to the next person to sign in", () async {
    final repo = _MockRepo();
    var calls = 0;
    when(() => repo.notificationPrefs()).thenAnswer((_) async {
      calls++;
      return [AlertKindPref(kind: 'order_unassigned', en: 'Unassigned orders', push: calls == 1)];
    });
    final container = ProviderContainer(overrides: [
      managerRepoProvider.overrideWithValue(repo),
      signedInProvider.overrideWith((ref) => ref.watch(_signedIn)),
    ]);
    addTearDown(container.dispose);
    final sub = container.listen(notificationPrefsProvider, (_, _) {});
    addTearDown(sub.close);

    expect((await container.read(notificationPrefsProvider.future)).single.push, isTrue);

    container.read(_signedIn.notifier).set(false);
    expect(await container.read(notificationPrefsProvider.future), isEmpty);

    container.read(_signedIn.notifier).set(true);
    expect((await container.read(notificationPrefsProvider.future)).single.push, isFalse);
    expect(calls, 2);
  });
}
