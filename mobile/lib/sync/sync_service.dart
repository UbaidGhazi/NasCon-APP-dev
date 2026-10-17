import 'dart:convert';
import 'package:dio/dio.dart';
import '../core/api_client.dart';
import '../data/action_queue.dart';

class SyncService {
  static const Map<String, String> errorExplanations = {
    'SQUAD_FULL': 'That squad is already full.',
    'NOT_IN_SQUAD': 'This player is no longer in that squad.',
    'TRANSFER_WINDOW_CLOSED': 'The transfer window was closed on that date.',
    'PLAYER_ON_LOAN': 'This player is currently on loan and can\'t be moved.',
    'MATCH_NOT_IN_PROGRESS': 'That match wasn\'t live when the action was recorded.',
    'INVALID_BASE_VERSION': 'Your device was ahead of the server. Refresh and try again.',
    'DUPLICATE_EVENT_ID': 'This was already recorded.',
  };

  static Future<Map<String, dynamic>> sync(String deviceId) async {
    final actions = ActionQueue.pendingActions;
    if (actions.isEmpty) return {'status': 'empty'};

    final body = {
      'device_id': deviceId,
      'actions': actions.map((a) => a.toJson()).toList(),
    };

    final response = await ApiClient().dio.post(
      '/audit/v1/offline-sync',
      data: body,
    );

    if (response.statusCode == 200) {
      ActionQueue.clear();
      return response.data;
    }
    throw Exception('Sync failed with status ${response.statusCode}');
  }

  static String formatError(String errorCode) {
    return errorExplanations[errorCode] ?? 'Server rejected: $errorCode';
  }
}
