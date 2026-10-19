package redis

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	addr string
}

func NewClient(rawURL string) *Client {
	if rawURL == "" {
		return nil
	}
	addr := rawURL
	if strings.HasPrefix(rawURL, "redis://") {
		u, err := url.Parse(rawURL)
		if err == nil {
			addr = u.Host
		}
	}
	if !strings.Contains(addr, ":") {
		addr += ":6379"
	}
	return &Client{addr: addr}
}

func (c *Client) Get(key string) (string, error) {
	if c == nil || c.addr == "" {
		return "", fmt.Errorf("redis client not configured")
	}
	conn, err := net.DialTimeout("tcp", c.addr, 2*time.Second)
	if err != nil {
		return "", err
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))

	cmd := fmt.Sprintf("*2\r\n$3\r\nGET\r\n$%d\r\n%s\r\n", len(key), key)
	if _, err := conn.Write([]byte(cmd)); err != nil {
		return "", err
	}

	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil {
		return "", err
	}
	if strings.HasPrefix(line, "$-1") { // Key not found
		return "", nil
	}
	if strings.HasPrefix(line, "$") {
		lengthStr := strings.TrimSpace(line[1:])
		length, err := strconv.Atoi(lengthStr)
		if err != nil {
			return "", err
		}
		buf := make([]byte, length+2)
		if _, err := io.ReadFull(reader, buf); err != nil {
			return "", err
		}
		return string(buf[:length]), nil
	}
	return "", fmt.Errorf("unexpected redis reply: %s", line)
}

func (c *Client) GetInt(key string) (int, error) {
	val, err := c.Get(key)
	if err != nil || val == "" {
		return 0, err
	}
	return strconv.Atoi(strings.TrimSpace(val))
}
