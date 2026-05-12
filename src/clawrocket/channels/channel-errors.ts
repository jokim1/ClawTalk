export type ChannelDeliveryErrorKind =
  | 'permanent'
  | 'transient'
  | 'rate_limited';

export class ChannelDeliveryError extends Error {
  kind: ChannelDeliveryErrorKind;
  code: string;

  constructor(message: string, kind: ChannelDeliveryErrorKind, code: string) {
    super(message);
    this.name = 'ChannelDeliveryError';
    this.kind = kind;
    this.code = code;
  }
}
