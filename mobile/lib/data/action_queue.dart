import 'dart:convert';
import 'package:uuid/uuid.dart';

/// Exactly the §5.14 action shape required by the competition
class QueuedAction {
  final String actionId;
  final String type; // 'score_event' or 'roster_transfer'
  final String queuedAt;
  final int baseVersion;
  final Map<String, dynamic> payload;

  QueuedAction({
    required this.actionId,
    required this.type,
    required this.queuedAt,
    required this.baseVersion,
    required this.payload,
  });

  Map<String, dynamic> toJson() => {
    'action_id': actionId,
    'type': type,
    'queued_at': queuedAt,
    'base_version': baseVersion,
    'payload': payload,
  };

  factory QueuedAction.fromJson(Map<String, dynamic> json) => QueuedAction(
    actionId: json['action_id'],
    type: json['type'],
    queuedAt: json['queued_at'],
    baseVersion: json['base_version'] ?? 1,
    payload: Map<String, dynamic>.from(json['payload']),
  );
}

class ActionQueue {
  static final List<QueuedAction> _inMemoryQueue = [];

  static List<QueuedAction> get pendingActions => List.unmodifiable(_inMemoryQueue);

  static void enqueue(String type, Map<String, dynamic> payload, {int baseVersion = 1}) {
    final action = QueuedAction(
      actionId: 'a-${const Uuid().v4()}',
      type: type,
      queuedAt: DateTime.now().toUtc().toIso8601String(),
      baseVersion: baseVersion,
      payload: payload,
    );
    _inMemoryQueue.add(action);
  }

  static void clear() {
    _inMemoryQueue.clear();
  }
}
