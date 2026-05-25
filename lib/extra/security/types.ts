export enum UserType {
  Unknown = 'unknown',
  User = 'user',
  Admin = 'admin',
}

export const USER_TYPE_LEVEL: Record<UserType, number> = {
  [UserType.Unknown]: 0,
  [UserType.User]: 1,
  [UserType.Admin]: 2,
};

export function userTypeFromString(value: string): UserType {
  switch (value) {
    case 'admin':
      return UserType.Admin;
    case 'user':
      return UserType.User;
    default:
      return UserType.Unknown;
  }
}

export function hasPermission(actual: UserType, required: UserType): boolean {
  return USER_TYPE_LEVEL[actual] >= USER_TYPE_LEVEL[required];
}
