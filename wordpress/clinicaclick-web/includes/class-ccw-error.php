<?php

if (!defined('ABSPATH') && !defined('CCW_TESTING')) {
    exit;
}

final class CCW_Error extends RuntimeException
{
    /** @var string */
    private $error_code;

    /** @var array<string,mixed> */
    private $details;

    /**
     * @param array<string,mixed> $details
     */
    public function __construct($error_code, $message, array $details = array(), Throwable $previous = null)
    {
        parent::__construct((string) $message, 0, $previous);
        $this->error_code = (string) $error_code;
        $this->details = $details;
    }

    public function error_code()
    {
        return $this->error_code;
    }

    /** @return array<string,mixed> */
    public function details()
    {
        return $this->details;
    }
}
