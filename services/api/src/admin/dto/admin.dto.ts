import { IsString, IsNotEmpty, IsOptional, IsNumber, Min } from 'class-validator';

export class CreateUserDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;

  @IsString()
  @IsOptional()
  role?: string;

  @IsNumber()
  @IsOptional()
  client_id?: number;

  @IsString()
  @IsOptional()
  workspaceName?: string;

  @IsString()
  @IsOptional()
  workspace_name?: string;

  @IsString()
  @IsOptional()
  businessType?: string;

  @IsString()
  @IsOptional()
  business_type?: string;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trialMinutes?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trial_minutes?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trialHours?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trial_hours?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trialDays?: number;

  @IsNumber()
  @IsOptional()
  @Min(1)
  trial_days?: number;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  password!: string;
}
