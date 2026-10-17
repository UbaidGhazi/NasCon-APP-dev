import 'dart:convert';
import 'package:hive_flutter/hive_flutter.dart';

class HiveCache {
  static const String fixturesBoxName = 'fixtures_cache';
  static const String standingsBoxName = 'standings_cache';
  static const String clubsBoxName = 'clubs_cache';

  static Future<void> init() async {
    await Hive.initFlutter();
    await Hive.openBox<String>(fixturesBoxName);
    await Hive.openBox<String>(standingsBoxName);
    await Hive.openBox<String>(clubsBoxName);
  }

  static Future<void> cacheData(String boxName, String key, dynamic data) async {
    final box = Hive.box<String>(boxName);
    await box.put(key, jsonEncode(data));
  }

  static dynamic getCachedData(String boxName, String key) {
    final box = Hive.box<String>(boxName);
    final raw = box.get(key);
    if (raw == null) return null;
    return jsonDecode(raw);
  }
}
